# Arianna

Assistente personale e sistema multi-agente che gira in locale o su un server tuo. I dati privati (L2/L3) sono letti solo da modelli locali; il codice e il lavoro non privato passano da Claude Code e Codex con abbonamento, senza API.

## Da dove iniziare

1. Leggi `docs/SPEC.md` (specifica completa, esportata dal documento "Progetto Arianna").
2. Leggi `CLAUDE.md`: sono le regole che Claude Code segue in questo repository.
3. Apri `docs/PHASE-0-1-TASKS.md`: fai i tre passi "Prima di tutto", poi parti dal primo task della Fase 0.
4. Le decisioni ancora aperte sono in `docs/OPEN-QUESTIONS.md`, ognuna con la scadenza entro cui va chiusa.
5. Le decisioni marcate "Proposta, applicata" in `docs/DECISIONS.md` vengono dalla revisione critica del 2026-10-02: confermale o rifiutale.

## Indice dei documenti

| File | Contenuto |
| --- | --- |
| `docs/SPEC.md` | Specifica completa (fonte di verità sui requisiti; sui dettagli valgono i documenti sotto, D-013) |
| `docs/ARCHITECTURE.md` | Componenti, flussi, struttura del repository |
| `docs/PRIVACY-POLICY-SPEC.md` | Livelli L0-L3, regole del gateway, contaminazione di sessione |
| `docs/ROUTER-SPEC.md` | Scelta del modello: filtri, difficoltà, fallback, adattatori |
| `docs/AGENT-CARDS.md` | Formato delle schede agente e agenti iniziali |
| `docs/DATA-MODEL.md` | Bozza dello schema PostgreSQL |
| `docs/EVALS.md` | Harness di valutazione e casi di test |
| `docs/SECURITY.md` | Minacce, controlli, gestione segreti |
| `docs/INSTALLER-PORTABILITY.md` | Installer e wizard, modelli dal catalogo, cartella unica, sincronizzazione Synology |
| `docs/ROADMAP.md` | Fasi, criteri di uscita, stime di tempo |
| `docs/PHASE-0-1-TASKS.md` | Task con ore, ordine e criteri di completamento |
| `docs/DEV-WORKFLOW.md` | Come si lavora con Claude Code, prompt iniziali |
| `docs/REFERENCES.md` | Progetti esterni analizzati (pixel-agents, OpenJarvis) e decisioni |
| `docs/DECISIONS.md` | Registro delle decisioni (ADR) |
| `docs/HANDOFF.md` | Consegna fra conversazioni: stato, prossimi passi, attese |
| `docs/OPEN-QUESTIONS.md` | Decisioni aperte e idee da scegliere |

## Stato

Fase 0 in corso: lo stato di ogni task è nella colonna "Reali" di `docs/PHASE-0-1-TASKS.md`. Documenti rivisti il 2026-10-02 (revisione critica: privacy, piano, incoerenze). Le stime sono mie, non misurate: si ricalibrano alla fine della Fase 0.
