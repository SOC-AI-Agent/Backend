export class TextToSplResponse {
  /** The text sent to Text-to-SPL (`saia_generate_spl`): the requirement, the details, where to search, the time range. */
  prompt: string;

  /** The SPL as Splunk's Text-to-SPL wrote it. */
  generated_spl: string;

  /** What a lookup would run: the guard passed it, with the time range added. Null when the guard refused it. */
  spl: string | null;

  /** Why the guard would not run it — it writes, deletes or sends data out. Null when it passed. */
  refused: string | null;

  /** Always false: this endpoint asks for the SPL and never searches. */
  searched: boolean;
}
