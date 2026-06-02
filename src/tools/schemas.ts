import { z } from "zod";

/**
 * Shared zod schemas for Lexware write payloads.
 *
 * These are intentionally lenient (`.passthrough()` keeps unknown keys) because
 * the full Lexware document schema is large and version-dependent. We validate
 * the load-bearing required fields and forward the rest untouched, so valid
 * requests aren't blocked by an incomplete model.
 */

export const moneySchema = z
  .object({
    currency: z.string().default("EUR").describe("ISO currency; Lexware supports EUR."),
    netAmount: z.number().optional(),
    grossAmount: z.number().optional(),
    taxRatePercentage: z.number().optional().describe("Tax rate, e.g. 19 or 7 or 0."),
  })
  .passthrough();

export const lineItemSchema = z
  .object({
    type: z.string().describe('Line type, e.g. "custom", "material", "service", "text".'),
    name: z.string(),
    description: z.string().optional(),
    quantity: z.number().optional(),
    unitName: z.string().optional().describe('e.g. "piece", "hour".'),
    unitPrice: moneySchema.optional(),
  })
  .passthrough();

export const addressSchema = z
  .object({
    contactId: z.string().optional().describe("Reference an existing contact by id."),
    name: z.string().optional().describe("Recipient name for a one-off address."),
    countryCode: z.string().optional().describe('ISO country code, e.g. "DE".'),
  })
  .passthrough()
  .refine((a) => Boolean(a.contactId) || Boolean(a.name), {
    message: "address requires either contactId or a name (one-off address).",
  });

export const taxConditionsSchema = z
  .object({
    taxType: z
      .string()
      .describe('e.g. "net", "gross", "vatfree", "intraCommunitySupply", "thirdPartyCountry".'),
  })
  .passthrough();

export const shippingConditionsSchema = z
  .object({
    shippingType: z.string().describe('e.g. "service", "delivery", "none".'),
  })
  .passthrough();

/** Fields common to every voucher document; specific shapes spread this. */
const baseDocumentShape = {
  voucherDate: z.string().describe("ISO date/dateTime of the document."),
  address: addressSchema,
  lineItems: z.array(lineItemSchema).min(1).max(300),
  totalPrice: z
    .object({ currency: z.string().default("EUR") })
    .passthrough()
    .describe("Must include the currency (EUR)."),
  taxConditions: taxConditionsSchema,
  title: z.string().optional(),
  introduction: z.string().optional(),
  remark: z.string().optional(),
} as const;

/** Invoice (draft or finalized): base fields + required shippingConditions. */
export const invoiceInputShape = {
  ...baseDocumentShape,
  shippingConditions: shippingConditionsSchema,
} as const;

/** Quotation: base fields + expirationDate (no shippingConditions). */
export const quotationInputShape = {
  ...baseDocumentShape,
  expirationDate: z.string().describe("ISO date the quotation is valid until."),
} as const;

/**
 * Generic voucher-document body, used for credit notes, order confirmations,
 * delivery notes, etc. Lenient: `shippingConditions` is optional since it varies
 * by document type.
 */
export const genericDocumentInputShape = {
  ...baseDocumentShape,
  shippingConditions: shippingConditionsSchema.optional(),
} as const;

/** Update an article: full body plus the current optimistic-locking version. */
export const articleInputShape = {
  title: z.string(),
  type: z.enum(["PRODUCT", "SERVICE"]),
  unitName: z.string().describe('e.g. "piece", "hour".'),
  articleNumber: z.string().optional(),
  gtin: z.string().optional(),
  description: z.string().optional(),
  price: z
    .object({
      leadingPrice: z.enum(["NET", "GROSS"]),
      taxRate: z.number(),
      netPrice: z.number().optional(),
      grossPrice: z.number().optional(),
    })
    .passthrough(),
} as const;

/** Minimal contact creation: roles + person or company. version must be 0 for create. */
export const contactInputShape = {
  roles: z
    .object({
      customer: z.object({}).passthrough().optional(),
      vendor: z.object({}).passthrough().optional(),
    })
    .describe('At least one role, e.g. { "customer": {} }.'),
  person: z
    .object({ salutation: z.string().optional(), firstName: z.string().optional(), lastName: z.string() })
    .passthrough()
    .optional()
    .describe("For a private person; lastName is required."),
  company: z
    .object({ name: z.string() })
    .passthrough()
    .optional()
    .describe("For a company; name is required."),
  note: z.string().optional(),
} as const;
