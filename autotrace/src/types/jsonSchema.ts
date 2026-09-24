/**
 * The small subset of JSON Schema AutoTrace needs to describe a required model response shape.
 * Providers that support structured output are given this schema so the model is constrained while
 * generating, but it never replaces runtime validation of what the model actually returned.
 */
export type JsonSchema = {
  type: "object" | "array" | "string";
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: string[];
  minItems?: number;
  maxItems?: number;
};
