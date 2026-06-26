import { openai } from '@ai-sdk/openai';
import { streamText } from 'ai';
import { z } from 'zod';
import { createServerClient, parseCookieHeader } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'edge';

// ─────────────────────────────────────────────
//  Supabase Admin Client（RLS をバイパスした
//  サーバー専用クライアント。Secret Key は
//  絶対にフロントに漏らさないこと）
// ─────────────────────────────────────────────
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: Request) {
  try {
    // ──────────────────────────────────────────
    // STEP 1: ストリーム破損防止のため最優先で
    //         リクエスト Body をパース
    // ──────────────────────────────────────────
    const { messages } = await req.json();

    // ──────────────────────────────────────────
    // STEP 2: Cookie からセッションユーザーを
    //         安全に検証（認証情報偽装対策）
    // ──────────────────────────────────────────
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return parseCookieHeader(req.headers.get('Cookie') ?? '');
          },
          setAll() {
            // Edge Runtime ではレスポンスヘッダーへの Cookie 書き込みは
            // 呼び出し側で行うため、ここでは何もしない
          },
        },
      }
    );

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return new Response('Unauthorized', { status: 401 });
    }

    const userId = user.id;

    // ──────────────────────────────────────────
    // STEP 3: AI チャットストリーミング開始
    //         Tools（Function Calling）を登録
    // ──────────────────────────────────────────
    const result = await streamText({
      model: openai('gpt-4o-mini'),
      system: `あなたは1人起業家・フリーランスの雑務を助けるAIアシスタント「Zatsumu」です。
日本語で簡潔・丁寧に回答してください。
請求書発行が必要な場合は必ず create_invoice ツールを呼び出してください。
取引先名・金額・品目が不明な場合は先にユーザーへ確認してください。`,
      messages,
      tools: {
        // ──────────────────────────────────────
        // Tool: 請求書（Stripe Payment Link）発行
        // ──────────────────────────────────────
        create_invoice: {
          description:
            'Stripe で請求書（決済リンク）を発行します。金額・品目・取引先名が揃ってから呼び出してください。',
          parameters: z.object({
            amount: z
              .number()
              .positive()
              .describe('金額（日本円単位、例: 50000）'),
            description: z
              .string()
              .describe('品目や請求内容（例: 6月分Webサイト制作費）'),
            client_name: z
              .string()
              .describe('宛先となる取引先名（例: 株式会社サンプル）'),
          }),
          execute: async ({ amount, description, client_name }) => {
            // ────────────────────────────────
            // 1. 事前に使用カウントを消費
            //    （TOCTOU 競合・API代踏み倒し対策）
            // ────────────────────────────────
            const { error: rpcError } = await supabaseAdmin.rpc(
              'increment_usage_and_log',
              {
                p_user_id: userId,
                p_task_type: 'invoice',
              }
            );

            if (rpcError) {
              // 独自エラーコード P0001 = 月間上限超え
              if (rpcError.code === 'P0001') {
                return {
                  error:
                    '月間タスク上限（30回）に達しました。プレミアムプラン（月額980円）への移行をご検討ください。',
                };
              }
              // その他の DB エラー
              throw rpcError;
            }

            try {
              // ────────────────────────────────
              // 2. Stripe Price オブジェクトを生成
              // ────────────────────────────────
              const priceResponse = await fetch(
                'https://api.stripe.com/v1/prices',
                {
                  method: 'POST',
                  headers: {
                    Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
                    'Content-Type': 'application/x-www-form-urlencoded',
                  },
                  body: new URLSearchParams({
                    currency: 'jpy',
                    unit_amount: amount.toString(),
                    'product_data[name]': `${description}（宛先: ${client_name}）`,
                  }),
                }
              );

              const priceData = await priceResponse.json();

              if (priceData.error) {
                throw new Error(
                  `Stripe Price 作成失敗: ${priceData.error.message}`
                );
              }

              const priceId: string = priceData.id;

              // ────────────────────────────────
              // 3. Payment Link を生成
              // ────────────────────────────────
              const linkResponse = await fetch(
                'https://api.stripe.com/v1/payment_links',
                {
                  method: 'POST',
                  headers: {
                    Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
                    'Content-Type': 'application/x-www-form-urlencoded',
                  },
                  body: new URLSearchParams({
                    'line_items[0][price]': priceId,
                    'line_items[0][quantity]': '1',
                  }),
                }
              );

              const linkData = await linkResponse.json();

              if (linkData.error) {
                throw new Error(
                  `Stripe Payment Link 作成失敗: ${linkData.error.message}`
                );
              }

              return {
                url: linkData.url as string,
                message: `✅ 請求書を発行しました。以下の決済リンクを ${client_name} 様にお送りください。`,
              };
            } catch (error: any) {
              // ────────────────────────────────
              // 4. 失敗時: 補償トランザクションで
              //    カウントとログをロールバック
              // ────────────────────────────────
              console.error('Stripe 処理失敗。使用カウントをロールバック:', error);

              await supabaseAdmin.rpc('decrement_usage_and_rollback', {
                p_user_id: userId,
                p_task_type: 'invoice',
              });

              return {
                error:
                  error.message ||
                  '請求書の発行中に予期せぬエラーが発生しました。もう一度お試しください。',
              };
            }
          },
        },
      },
    });

    return result.toAIStreamResponse();
  } catch (error) {
    console.error('Chat API エラー:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}
