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
| Furto o abuso delle credenziali | `sops` + `age` (`@arianna/vault`, D-042): chiave age fuori da `ARIANNA_HOME`, `sops` lanciato con un ambiente ridotto, valore solo con `reveal()`; il gateway blocca ogni uscita che contiene un valore rivelato; nessun token OAuth estratto; L3 solo come riferimenti; ambiente pulito per i processi figli |
| Catena di fornitura (pacchetto, server MCP o skill ostile) | Versioni esatte e lockfile con hash in git; nessuna release più giovane di un giorno (`minimumReleaseAge`); script di installazione dei pacchetti non eseguiti; ogni dipendenza ha una voce in `DECISIONS.md`; server MCP in container senza accesso ai dati privati |
| Costi o cicli fuori controllo | Tetti di passi, tempo, costo/quota per task; scheduler deterministico |
| Manomissione del registro | Eventi append-only con catena di hash, verificata da `arianna doctor` |
| Accesso remoto al server | VPN (WireGuard o Tailscale), nessuna porta esposta, autenticazione sull'HUD |
| Pagina web ostile che usa il browser dell'utente contro l'API locale (DNS rebinding, CSRF, WebSocket da un altro sito) | API solo su loopback; `Host` ammesso solo se è l'indirizzo del core; `Origin` dello stesso host per scritture e WebSocket; scritture solo in JSON; nessun header CORS; CSP stretta (D-039). Fino all'autenticazione (1.13) ogni processo locale può usare l'API: gli esecutori cloud ne sono esclusi dalla sandbox (1.6) |
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
  - se l'input non è leggibile, l'hook nega (fail-closed); se invece lo script va in errore prima di partire, Claude Code prosegue senza blocco, quindi i suoi test girano dentro `pnpm test`;
  - i test stanno in `.claude/hooks/block-outside-repo.test.js`; `.claude/hooks/package.json` tiene gli script in CommonJS anche se il monorepo è ESM.
- La protezione vera per i comandi di shell è la sandbox del sistema operativo: `node` e `pnpm` eseguono codice arbitrario, e l'hook guarda solo il testo del comando. Per lo sviluppo non è configurata nel repository: la attiva l'utente con `/sandbox` in Claude Code. Per gli esecutori lanciati da Arianna è il task 1.6.

## Servizi locali e database

- PostgreSQL ascolta solo su `127.0.0.1` e la configurazione rifiuta host diversi dal loopback, perché il driver non usa TLS.
- In sviluppo la password del database è un valore fisso, scritto in `compose.yaml` e nel codice (D-028): va bene solo finché il database contiene dati finti. **Prima dei dati veri** serve una password non predefinita, verificata da `arianna doctor`. L'immagine legge la password solo alla prima inizializzazione: per cambiarla dopo serve `ALTER ROLE`, non basta la variabile d'ambiente.
- La copia di lavoro di un esecutore cloud non è un `git worktree`: altrimenti potrebbe leggere tutta la storia del repository d'origine (segreti cancellati compresi) e scrivere nella sua `.git` (hook, `core.fsmonitor`, filtri) codice eseguito poi fuori dalla sandbox. È un repository nuovo con un solo commit, scritto senza filtri né hook (D-041).
- Un esecutore cloud gira sulla stessa macchina e può raggiungere via loopback il database, Qdrant e il modello locale: sarebbe un percorso L2 verso il cloud che non passa dal gateway. La sandbox del task 1.6 deve negare queste connessioni, e il test del canarino lo verifica.
- Il campo `detail` degli errori di PostgreSQL contiene la riga rifiutata, payload compreso: non va scritto nei log per eventi L2 o superiori.

## Vault

- Primo avvio, a mano: `age-keygen -o <file>` nella posizione dove `sops` cerca la chiave (su macOS `~/Library/Application Support/sops/age/keys.txt`, oppure un file indicato da `SOPS_AGE_KEY_FILE`), poi `pnpm vault:init <chiave pubblica age1...>` e `pnpm vault:edit`. Le chiavi del file sono di primo livello: `nome: valore`, letto come `vault://nome`.
- La chiave privata non entra mai in `ARIANNA_HOME`, in git o nella cartella sincronizzata: senza di lei `data/vault/secrets.yaml` è illeggibile, e perderla vuol dire perdere i segreti. Va conservata a parte (per esempio nel gestore di password).
- Il controllo del gateway confronta valori esatti: un segreto trasformato (in base64, spezzato, abbreviato) non si riconosce. È una rete, non il controllo principale, che resta non mettere mai il valore in un testo.
