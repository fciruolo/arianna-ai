# Arianna — regole per Codex

Questo file è per Codex CLI, lanciato con `pnpm dev:codex` (D-143). Le regole del progetto sono quelle di `CLAUDE.md`: leggilo per intero all'inizio di ogni sessione e seguilo come se fosse scritto per te, con le eccezioni qui sotto, che per te prevalgono (le riconosce la riga di `pnpm dev:codex` in `CLAUDE.md`). Per tutto il resto, se questo file e `CLAUDE.md` si contraddicono, fermati e dillo all'utente.

## Il sandbox

- Lavori dentro un profilo di permessi e nessun comando esce dal sandbox: l'approvazione è spenta (`approval_policy="never"`), un comando che il sandbox rifiuta fallisce e basta. Non chiedere di rilanciarlo fuori: il codice che scrivi girerebbe senza sandbox e il suo output tornerebbe al cloud.
- Tutto ciò che git esclude (`data/`, `kb/inbox/`, `kb/progetti/`, `config/arianna.toml`, `config/models.user-catalog.yaml`, `repos/`, i file locali di `.claude/`…) e le cartelle di lavoro di Claude Code in `.claude/worktrees/` sono chiusi: dati non etichettati, quindi L2. Non chiedere di leggerli; `data/dev/RISPOSTE.md` lo applica solo Claude Code. Fa eccezione `data/test-tmp`, che serve ai test.
- In sola lettura, anche se non esistono: `.git`, `.githooks/`, `.claude/`, `.codex/`, `.agents/`, `CLAUDE.md`, `CLAUDE.local.md`, questo file, `AGENTS.override.md`, `.mcp.json`, `package.json`, `.npmrc` ed `eslint.config.js` (le regole che ti confinano e ciò che `pnpm check` esegue fuori dal sandbox). Se serve cambiarli, scrivi la modifica proposta nella risposta e la applica l'utente.
- Niente rete dentro il sandbox, niente ricerca web.

## All'inizio

- Leggi `CLAUDE.md`, `docs/HANDOFF.md` (dalla sezione più recente) e, per il contesto, `docs/SPEC.md` e `docs/ROADMAP.md`.
- Non controllare né avviare database, core e chat: lo fa Claude Code. Se servono per una prova, dillo all'utente.
- Non leggere la quota (`ai-usage-bar`): la regola vale per Claude Code.

## Durante il lavoro

- Si lavora su un ramo `task/<nome>` creato da `main`, mai su `main`. `.git` è in sola lettura: il ramo lo crea l'utente nel suo terminale prima di lanciarti, o glielo chiedi con il comando esatto. Non chiedere cambi di ramo mentre l'utente prova qualcosa nella chat: core e chat girano da questa cartella.
- La regola "Ramo di core e chat per le prove" di `CLAUDE.md` (spostare la cartella sul ramo e riavviare core e chat) non è tua: scrivi in `docs/HANDOFF.md` che core e chat vanno riavviati sul ramo, lo farà l'utente o Claude Code.
- Dentro il sandbox puoi lanciare `pnpm build`, `pnpm test`, `pnpm lint` e `pnpm eval`; i test che aprono server su loopback possono fallire. `pnpm test:db` (PostgreSQL) non lo lanci tu: scrivi in `docs/HANDOFF.md` che va lanciato, e lo farà Claude Code.
- Niente nuove dipendenze senza una voce in `docs/DECISIONS.md`, niente percorsi assoluti nel codice.

## Commit, revisione e prova

- Commit, `pnpm check` completo, unioni e tag li lancia l'utente nel suo terminale, mai tramite te. A fine lavoro scrivi i comandi da copiare (`pnpm check`, `git add …`, `git commit -m "…"` con il messaggio che cita l'id del task o della decisione); l'hook `.githooks/pre-commit` rilancia `pnpm check`, mai `--no-verify`.
- Non hai il subagente `reviewer` di Claude Code. Prima di proporre il commit rileggi tu il diff con i suoi criteri: privacy (nessun dato L2/L3 verso il cloud, uscite solo dal gateway), test positivi e negativi per `packages/policy` e `packages/router`, aderenza alla specifica. Scrivi in `docs/HANDOFF.md` che il `reviewer` va ancora fatto.
- Non hai lo strumento delle domande a opzioni (`AskUserQuestion`): le domande all'utente le fai in testo, una per volta e mai sciolte in fondo a un messaggio, spiegando il problema e con opzioni numerate, la consigliata per prima e le conseguenze di ciascuna. Una domanda che resta aperta oltre la conversazione va in `docs/OPEN-QUESTIONS.md` (o in `docs/PROPOSTE.md`) nel formato di D-122 descritto in `CLAUDE.md` (`- Contesto:`, `- Opzione consigliata:`, `- Opzione:`, `- Esempio:`), così compare nella pagina "Sviluppo di Arianna".
- Prova dei lavori finiti: una domanda per ogni lavoro, mai una per più lavori, con i passi numerati (dove cliccare, cosa scrivere, cosa si deve vedere) e le opzioni 1. "Funziona", 2. "Non funziona" (con i dettagli), 3. "Non ancora provato". Un lavoro si unisce a `main` solo con "Funziona".

## Alla fine

- Aggiorna `docs/HANDOFF.md`, `CHANGELOG.md` sotto `## [Non rilasciato]` (sezioni Aggiunto, Cambiato, Corretto, Sicurezza, Rimosso; una riga per voce con l'id) e `docs/DECISIONS.md`, come chiede `CLAUDE.md`. All'unione in `main`, dopo "Funziona", la sezione diventa una versione con il `version` del `package.json` e il tag annotato, come in `CLAUDE.md`: li fa l'utente (o Claude Code), niente push. In HANDOFF scrivi che il lavoro l'hai fatto tu (Codex), con il ramo e cosa manca: commit, `reviewer`, `test:db`, prova.
- Documenti in italiano; codice, nomi e commenti in inglese.
