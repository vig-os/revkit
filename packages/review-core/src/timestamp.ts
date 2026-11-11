// Shared ISO-8601 timestamp validator. Events carry an ISO timestamp on the
// envelope (§5.3), and every persisted object records `createdAt` /
// `updatedAt` in the same shape. Kept in one file so a message that says
// "not an ISO-8601 timestamp" moves once, not per site.
import { z } from "zod";

/** ISO-8601 datetime with an offset (`Z` or `±hh:mm`). Zod's `.datetime()`
 * default rejects a bare local time; the field is used for wire and store
 * timestamps, both of which must be unambiguous across time zones. */
export const isoTimestamp = z.iso.datetime({ offset: true });
