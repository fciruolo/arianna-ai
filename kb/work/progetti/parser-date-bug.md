---
title: Bug del parser di date
tags: ["coding", "typescript"]
---

Nel progetto di prova il 31 dicembre diventa il 1 gennaio dell'anno dopo. Ipotesi: un mese contato da zero in `src/dates.ts`. Serve un test che lo riproduca prima della correzione.

Collegamenti: [[work/progetti/arianna-demo]].
