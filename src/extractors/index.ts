import { deliveryDate } from './delivery_date.js';
import { penaltyRate } from './penalty_rate.js';
import { supplier } from './supplier.js';
import { totalAmount } from './total_amount.js';
import type { Extractor } from './types.js';

/** Adding a field = a new extractor module + one line here. */
export const extractors: Extractor[] = [supplier, totalAmount, deliveryDate, penaltyRate];
