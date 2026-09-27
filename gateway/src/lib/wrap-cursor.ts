// Opaque gift-wrap paging cursor: "<12-digit server-receive second>:<wrap id>".
// It is the suffix of the RelayPool storage key after "giftwrap:<recipient>:",
// so resuming from it is an exact, exclusive range read. Lives in lib/ so
// route modules can validate cursors without importing the Durable Object.
export const WRAP_CURSOR = /^\d{12}:[0-9a-f]{64}$/;
