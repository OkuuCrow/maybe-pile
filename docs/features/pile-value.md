# Pile Value

- **Item page → Purchases:** a price, optional store and date. Amounts are stored as **integer minor units plus an ISO 4217 code**, with no floats. The default currency is set in Settings → Features → Pile Value.
- **Pile page → Pile Value:** per currency, the total spent, the amount still unfinished (Planned, In Progress, On Hold), the amount for never-started items, and the cost per hour played (from recorded hours).
- **No conversion:** Maybe Pile never converts between currencies and never looks up exchange rates. Each currency is a separate row.
- **Parsing:** inputs like `1,299.50` or `1200` are accepted. Decimals beyond the currency's minor unit are rejected (JPY has 0 decimals, KWD has 3).
