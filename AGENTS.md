# Arianna — regole per Codex

Questo file è per Codex CLI, lanciato con `pnpm dev:codex` (D-143). Le regole del progetto sono quelle di `CLAUDE.md`: leggilo per intero all'inizio di ogni sessione e seguilo come se fosse scritto per te, con le eccezioni qui sotto, che per te prevalgono (le riconosce la riga di `pnpm dev:codex` in `CLAUDE.md`). Per tutto il resto, se questo file e `CLAUDE.md` si contraddicono, fermati e dillo all'utente.

## All'inizio

- Leggi `CLAUDE.md`, `docs/HANDOFF.md` (dalla sezione più recente) e, per il contesto, `docs/SPEC.md` e `docs/ROADMAP.md`.
- Tutto ciò che git esclude (`data/`, `kb/inbox/`, `kb/progetti/`, `config/arianna.toml`, `config/models.user-catalog.yaml`, `repos/`, i file locali di `.claude/`…) e le cartelle di lavoro di Claude Code in `.claude/worktrees/` sono chiusi dal profilo di permessi: dati non etichettati, quindi L2. Non chiedere di leggerli e non proporre comandi fuori dal sandbox che li leggano; `data/dev/RISPOSTE.md` lo applica solo Claude Code. Fa eccezione `data/test-tmp`, che serve ai test. `.claude/`, `.githooks/`, `CLAUDE.md` e questo file sono in sola lettura: proponi le modifiche all'utente, non chiedere di scriverli fuori dal sandbox.
- Non controllare né avviare database, core e chat: lo fa Claude Code. Se servono per una prova, dillo all'utente.
- Non leggere la quota (`ai-usage-bar`): la regola vale per Claude Code.

## Durante il lavoro

- Lavora su un ramo `task/<nome>` creato da `main`, mai su `main`. Non cambiare ramo mentre l'utente prova qualcosa nella chat: core e chat girano da questa cartella. La regola "Ramo di core e chat per le prove" di `CLAUDE.md` (spostare la cartella sul ramo e riavviare core e chat) non è tua: proponi all'utente il `git switch` e scrivi in `docs/HANDOFF.md` che core e chat vanno riavviati sul ramo, lo farà lui o Claude Code.
- Il sandbox tiene `.git` in sola lettura. Per `git switch`, `git commit` e `git merge` chiedi l'approvazione: l'utente vede il comando e decide.
- Prima di ogni commit gira `pnpm check` (l'hook `.githooks/pre-commit` lo rilancia); mai `--no-verify`. I test che aprono server su loopback possono fallire dentro il sandbox: in quel caso chiedi di lanciare `pnpm check` fuori dal sandbox.
- `pnpm test:db` (PostgreSQL) non lo lanci tu: scrivi in `docs/HANDOFF.md` che va lanciato, e lo farà Claude Code.
- Niente ricerca web, niente nuove dipendenze senza una voce in `docs/DECISIONS.md`, niente percorsi assoluti nel codice.

## Revisione e prova

- Non hai il subagente `reviewer` di Claude Code. Prima del commit rileggi tu il diff con i suoi criteri: privacy (nessun dato L2/L3 verso il cloud, uscite solo dal gateway), test positivi e negativi per `packages/policy` e `packages/router`, aderenza alla specifica. Scrivi in `docs/HANDOFF.md` che il `reviewer` va ancora fatto.
- Non hai lo strumento delle domande a opzioni (`AskUserQuestion`): le domande all'utente le fai in testo, una per volta e mai sciolte in fondo a un messaggio, spiegando il problema e con opzioni numerate, la consigliata per prima e le conseguenze di ciascuna. Una domanda che resta aperta oltre la conversazione va in `docs/OPEN-QUESTIONS.md` (o in `docs/PROPOSTE.md`) nel formato di D-122 descritto in `CLAUDE.md` (`- Contesto:`, `- Opzione consigliata:`, `- Opzione:`, `- Esempio:`), così compare nella pagina "Sviluppo di Arianna".
- Prova dei lavori finiti: una domanda per ogni lavoro, mai una per più lavori, con i passi numerati (dove cliccare, cosa scrivere, cosa si deve vedere) e le opzioni 1. "Funziona", 2. "Non funziona" (con i dettagli), 3. "Non ancora provato". Un lavoro si unisce a `main` solo con "Funziona".

## Alla fine

- Aggiorna `docs/HANDOFF.md`, `CHANGELOG.md` sotto `## [Non rilasciato]` (sezioni Aggiunto, Cambiato, Corretto, Sicurezza, Rimosso; una riga per voce con l'id) e `docs/DECISIONS.md`, come chiede `CLAUDE.md`. All'unione in `main`, dopo "Funziona", la sezione diventa una versione con il `version` del `package.json` e il tag annotato, come in `CLAUDE.md`: commit, unione e tag li approva l'utente; niente push. In HANDOFF scrivi che il lavoro l'hai fatto tu (Codex), con il ramo e cosa manca: `reviewer`, `test:db`, prova.
- Documenti in italiano; codice, nomi e commenti in inglese.
