import { ApiError } from './lib.js';
// Live integration is enabled only after the observed upstream contract is verified.
export function providerReady() { return false; }
export async function createPayment() { throw new ApiError(503, 'PAYMENTS_UNAVAILABLE', '收款暂未开放，请晚一点再来。'); }
export async function queryPayment() { throw new ApiError(503, 'PAYMENTS_UNAVAILABLE', '暂时无法确认付款结果，请稍后重试。'); }
