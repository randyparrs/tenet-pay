# Error codes of the gateway judges

The gateway judges (contracts/) use the codes of contracts/ERRORS.md, with these changes.

| Code | Meaning |
|---|---|
| M4 | no terms registered for this merchant and terms hash |
| M6 | that terms hash is already registered with other terms; a registered version never changes |
| I10 | the body is larger than 12 KB |
| I11 | store email in a format the judge cannot read safely; send multipart with a text part |

M5 is no longer used: a claim whose terms hash has no registered version gives M4.
