/**
 * HTTP 統一錯誤回應。
 *
 * 功能位置：
 * - sendError()        : 行 22 — 所有錯誤回應統一為 { error: code }，不附帶細節
 * - notFoundHandler()  : 行 33 — 全站 404 同形回應
 *
 * 安全不變量：
 * 404 回應不得包含請求方法或路徑。註冊關閉時 register 路由不掛載，
 * 其 404 必須與「任何不存在路徑」的 404 逐位元組相同，
 * 掃描腳本才無法藉回應差異判斷註冊端點是否存在。
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

export interface ErrorBody {
  error: string;
}

export function sendError(reply: FastifyReply, status: number, code: string): FastifyReply {
  return reply.status(status).send({ error: code } satisfies ErrorBody);
}

export function notFoundHandler(_request: FastifyRequest, reply: FastifyReply): void {
  void sendError(reply, 404, 'not_found');
}
