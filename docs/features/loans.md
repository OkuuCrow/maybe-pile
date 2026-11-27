# Lent and borrowed (§14.10, Full mode)

Record that an item was lent to or borrowed from someone: name (free text, local only — no contacts
integration), date, optional due date and note, returned date. More → **Loans & people** lists open loans
with an “⚠ Overdue” flag (text + icon).

- Notification “Get it back” (off by default): on the due date, plus a Sunday digest of overdue loans.
  Names appear only if “Show people's names” is on.
- **Privacy**: names are personal data about other people — kept out of share pages, share cards,
  notifications (unless allowed) and logs; included in JSON exports and full backups. **Forget this person**
  replaces the name everywhere (loans and recommendations keep their dates).
- Data: `people` (shared with Recommended by), `loans`.
