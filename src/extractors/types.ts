export type FieldName = 'supplier' | 'total_amount' | 'delivery_date' | 'penalty_rate';
/** Fields shown as table columns, plus contract-level events stored as facts. */
export type FactField = FieldName | 'termination';

/** A piece of document text the extractors look at. Offsets are absolute in the document source. */
export interface Segment {
  text: string;
  start: number;
  paragraph_id: number | null;
  clause_no: string | null;
  /** Set when the segment is the new wording of a contract clause from an amendment. */
  replaces_clause: string | null;
}

export interface Fact {
  field: FactField;
  kind: 'fact';
  value: string;
  display: string;
  quote: string;
  start: number;
  end: number;
  paragraph_id: number | null;
  rule_id: string;
  replaces_clause: string | null;
}

export interface NoData {
  field: FieldName;
  kind: 'no_data';
  reason: string;
  quote: string;
  start: number;
  end: number;
  paragraph_id: number | null;
  rule_id: string;
}

export interface Rejected {
  field: FieldName;
  candidate: string;
  reason: string;
  rule_id: string;
  quote: string;
}

export interface ExtractResult {
  facts: Fact[];
  noData: NoData[];
  rejected: Rejected[];
}

export interface Extractor {
  field: FieldName;
  label: string;
  extract(segments: Segment[]): ExtractResult;
}
