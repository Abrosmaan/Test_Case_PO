import type { Resolution, ResolvedContract } from './resolve.js';

/** Contracts whose current delivery date is strictly before `date`, with a flag for pending proposals on that date. */
export function deliveryBefore(res: Resolution, date: string) {
  return res.contracts
    .filter((c) => c.fields.delivery_date.value !== null && c.fields.delivery_date.value < date)
    .map((c) => ({ contract: c, pending: c.proposals.filter((p) => p.field === 'delivery_date') }));
}

export function findContract(res: Resolution, contractNo: string): ResolvedContract | undefined {
  return res.contracts.find((c) => c.contract_no === contractNo);
}
