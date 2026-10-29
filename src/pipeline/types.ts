export type Stage = 'ingest' | 'segment' | 'classify' | 'extract' | 'resolve' | 'llm';

export interface Paragraph {
  id?: number;
  clause_no: string | null;
  line_no: number;
  start: number;
  end: number;
  text: string;
}

export interface TraceEntry {
  stage: Stage;
  rule_id: string | null;
  message: string;
  data?: Record<string, unknown>;
}

export interface UploadedFile {
  filename: string;
  buffer: Buffer;
}

export type FileResult =
  | { filename: string; status: 'ok'; document_id: number }
  | { filename: string; status: 'duplicate'; document_id: number; duplicate_of: string }
  | { filename: string; status: 'rejected'; reason: string };
