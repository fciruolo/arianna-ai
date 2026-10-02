# Riferimenti esterni analizzati

Analisi del 2 ottobre 2026 fatta su pagine pubbliche e README, **senza leggere il codice**; riassunti da riverificare prima di dipendere da un dettaglio. Per ogni progetto: decisione, motivo, cosa prendere.

| Progetto | Licenza | Decisione | Motivo |
| --- | --- | --- | --- |
| pixel-agents (pixel-agents-hq) | MIT | **Adottare** per l'ufficio pixel | TypeScript, React 19, Canvas 2D; interfaccia `HookProvider` indipendente dall'agente; server standalone (`npx pixel-agents`) incorporabile in una pagina; 9,4k stelle |
| OpenJarvis (Stanford) | Apache-2.0 | **Studiare, non adottare** | Framework Python/Rust concorrente; nel README non risulta un gateway con etichette di privacy come il nostro |
| jarvis.ceo | Open source (licenza da verificare) | **Ignorare** | App di dettatura vocale per Mac e telefono, prodotto diverso |
| Guida a pagamento "AI Voice Assistant" su Gumroad (17 $) | Commerciale | **Ignorare** | Guida per principianti, senza codice né dettagli tecnici |

## pixel-agents

- Si usa il server standalone, incorporato nell'HUD Vue come pagina separata (iframe o finestra), senza portarlo in Vue.
- Il provider proprio legge il registro eventi di Arianna (task 3.3) e si registra come `HookProvider`.
- Gli sprite derivano da lavori di terzi (JIK-A-4, Metro City); la documentazione dei manifest **non riporta licenza** per gli asset. Va bene per uso personale; prima di condividere o distribuire la cartella (Synology incluso se la apri ad altri) si sostituiscono con asset dalla licenza chiara. Voce in `OPEN-QUESTIONS.md`.
- Ritorna utile la modalità di ripiego che legge i file JSONL delle sessioni Claude Code: ci dà un'anteprima prima di scrivere il provider.

## OpenJarvis — cosa guardare

| Idea | Uso in Arianna |
| --- | --- |
| Skill nel formato aperto agentskills.io, con cataloghi (incluse le skill di Hermes Agent) | Valutare lo stesso formato per le skill di Arianna: stesse competenze utilizzabili da Hermes, Claude Code e Codex (idea 7) |
| Agente `morning_digest` pianificato | Modello per il brief giornaliero della Fase 5 |
| Ciclo di apprendimento dalle tracce locali | Idea per migliorare il router dalle decisioni registrate; dopo la Fase 1, non prima |
| Rilevamento automatico dell'hardware e scelta del motore | Input per `arianna doctor` e per il wizard (avviso RAM) |
| Valutazioni con energia, latenza e costo come metriche | Aggiungere latenza e costo ai report degli eval |
| Preset di configurazione (`init --preset`) | Idea per il wizard: profili "Mac Studio", "server Linux" |

Non prendiamo: struttura Python, agenti e router, perché il centro di Arianna è la politica di privacy con etichette e gateway unico, che non risulta presente. Controlla in particolare se esiste qualcosa di simile nel codice prima di escluderlo del tutto.

## Nome

Il progetto OpenJarvis usa il comando `jarvis`: un motivo in più per il nome Arianna (nessun conflitto di comandi).
