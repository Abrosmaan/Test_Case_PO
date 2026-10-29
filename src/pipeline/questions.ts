import type { Resolution, ResolvedContract } from './resolve.js';

/**
 * Contracts whose current delivery date is strictly before `date`, with pending proposals for that field.
 * Contracts terminated on the check date have no delivery obligation and are returned separately.
 */
export function deliveryBefore(res: Resolution, date: string) {
  const early = res.contracts.filter((c) => c.fields.delivery_date.value !== null && c.fields.delivery_date.value < date);
  return {
    hits: early.filter((c) => c.status !== 'terminated').map((c) => ({ contract: c, pending: c.proposals.filter((p) => p.field === 'delivery_date') })),
    terminated: early.filter((c) => c.status === 'terminated'),
  };
}

export function findContract(res: Resolution, contractNo: string): ResolvedContract | undefined {
  return res.contracts.find((c) => c.contract_no === contractNo);
}
