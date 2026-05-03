// Top-level meta package. Customers `npm i skelm` and import from here;
// the runtime types and builders all come from @skelm/core. The server
// surface (when added) is imported from @skelm/server explicitly so the
// browser/serverless friendliness of the core surface is preserved.

export * from '@skelm/core'
