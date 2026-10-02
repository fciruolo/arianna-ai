# Sicurezza

| Minaccia | Controllo |
| --- | --- |
| Fuga di dati L2/L3 nel prompt verso il cloud | Gateway unico, default-deny, contaminazione di sessione, scanner deterministico, log delle uscite, eval al 100% |
| Fuga attraverso l'orchestratore: un brief scritto dal modello locale dopo aver letto L2 | Taint e clearance (D-015): contesto per task, conversazioni di lavoro a L1, declassamento solo con approvazione del testo esatto |
| Esecutore cloud che legge file fuori dal compito | Confinamento (D-014): allowlist, worktree per run, scansione preventiva, sandbox, canarino |
| Esecutore cloud che eredita connettori e impostazioni del profilo utente | Solo i server MCP di Arianna, nessuna impostazione utente caricata; verificato dal test di contratto |
| Strumento MCP che restituisce L2 a una sessione cloud | Il server degli strumenti conosce la clearance della sessione e nega sopra L1 |
| Contenuti L2 su Telegram o al telefono | Canali esterni dietro gateway (D-016): al massimo L1, L2 come riferimento |
| Prompt injection da contenuti non fidati | Lethal trifecta rimosso per scheda; Dual LLM; nessun invio esterno senza approvazione |
| Agente che esegue comandi dannosi | Permessi minimi (`--allowedTools`), sandbox, worktree; approvazione per le azioni irreversibili |
| Furto o abuso delle credenziali | `sops` + `age`; nessun token OAuth estratto; L3 solo come riferimenti; ambiente pulito per i processi figli |
| Costi o cicli fuori controllo | Tetti di passi, tempo, costo/quota per task; scheduler deterministico |
| Manomissione del registro | Eventi append-only con catena di hash, verificata da `arianna doctor` |
| Accesso remoto al server | VPN (WireGuard o Tailscale), nessuna porta esposta, autenticazione sull'HUD |
| Chiamate telefoniche | Audio nel cloud: nessuna lettura di L2 salvo abilitazione per chiamata; numeri ammessi in lista |
| Cambio regole degli abbonamenti | Adattatori sostituibili, test di contratto, controllo periodico delle pagine ufficiali |
| Perdita di dati | Backup cifrati di archivio, KB e database; ripristino provato in Fase 2 |

## Regole di sviluppo

- Dati finti ovunque in sviluppo; i dati veri entrano solo dopo il criterio di uscita della Fase 1A.
- Ogni azione esterna o irreversibile è registrata e, salvo autonomia esplicita, approvata.
- I permessi in `.claude/settings.json` negano file di segreti, `curl`, `wget` e `git push`; non si usano divieti larghi come `Read(~/**)`, perché il repository stesso sta nella home e resterebbe illeggibile.
- Il blocco fuori dal repository è affidato all'hook `.claude/hooks/block-outside-repo.js`:
  - per `Read`, `Edit`, `Write`, `Grep`, `Glob` e `NotebookEdit` il controllo è stretto: ogni percorso fuori dal repository è negato, symlink compresi;
  - per `Bash` è un'euristica: nega i comandi che nominano percorsi nella home, in `/Users`, `/Volumes` e simili fuori dal repository. Si aggira con variabili o sottocomandi, quindi è una rete di sicurezza contro gli errori, non una sandbox;
  - se l'input non è leggibile, l'hook nega (fail-closed);
  - i test stanno in `.claude/hooks/block-outside-repo.test.js` (`node --test .claude/hooks/block-outside-repo.test.js`).
- La protezione vera per i comandi di shell è la sandbox del sistema operativo: da attivare e verificare nel task 0.5 per lo sviluppo e nel task 1.6 per gli esecutori lanciati da Arianna.
