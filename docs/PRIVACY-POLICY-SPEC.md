# Specifica della policy di privacy

## Livelli

| Livello | Significato | Esempi | Chi può leggerlo |
| --- | --- | --- | --- |
| L0 | Pubblico | Documentazione open source, pagine web | Qualsiasi esecutore |
| L1 | Interno | Codice proprio non sensibile, appunti di lavoro | Locale e cloud, con log |
| L2 | Privato | Fatture, contratti, documenti personali, codice di clienti sotto NDA | Solo modelli locali |
| L3 | Segreto | Credenziali, chiavi, codici | Nessun modello: solo riferimenti al vault |

## Regole

1. **Default-deny:** un dato senza etichetta è L2.
2. **Contaminazione di sessione:** un agente che legge L2 resta locale per tutta la sessione; il router lo impone.
3. **Etichette solo verso l'alto:** abbassare un'etichetta richiede approvazione esplicita dell'utente, registrata in `label_changes`.
4. **Gateway unico:** tutto ciò che esce dalla macchina passa da `packages/policy`; il gateway blocca L2/L3 e registra ogni uscita (cosa, verso chi, perché). "Uscita" significa tutte e cinque le superfici elencate sotto, non solo il prompt.
5. **Codice di clienti con NDA:** L2 finché i contratti non sono stati letti.
6. **Segreti (L3):** mai nel prompt; solo riferimenti (`vault://nome`) risolti dal processo che li usa. Gestione con `sops` + `age` in `@arianna/vault` (D-042): il valore esce solo con `reveal()` e, stampato o serializzato, resta il riferimento. Ogni valore rivelato nel processo è noto al gateway, che blocca con la regola `secret` qualsiasi uscita che lo contiene, verso il modello locale e la chat web compresi; lo stesso controllo vale per i frammenti della risposta in streaming, uniti a quelli già inviati (D-043). I valori sotto 8 caratteri non si cercano, e il registro dei valori rivelati vale per il processo: dopo un riavvio un valore è noto di nuovo quando viene risolto.
7. **Voce:** la telefonia aggiunge un percorso audio nel cloud, quindi nessuna lettura di L2 ad alta voce salvo abilitazione per quella singola chiamata.
8. **Taint (D-015):** l'output di un modello ha l'etichetta più alta fra i suoi input. Un riassunto, un piano o un brief scritto da un modello che ha letto L2 è L2, anche se "sembra" innocuo.
9. **Clearance (D-015):** ogni conversazione, task e run ha un tetto (`clearance`) e un'etichetta effettiva (`effective_label`, il massimo di ciò che ha letto davvero). Una lettura sopra il tetto è negata, non contamina. Un esecutore cloud è ammesso solo se `effective_label ≤ L1`.
10. **Canali esterni (D-016):** Telegram e telefono sono destinazioni cloud come Claude Code. Ricevono al massimo L1; un contenuto L2 diventa una notifica con riferimento ("hai una carta in attesa, apri la chat web"). Solo la chat web raggiunta via VPN è un canale locale.
11. **Confinamento degli esecutori cloud (D-014):** un processo `claude` o `codex` vede solo la propria cartella di lavoro, in un progetto approvato (D-058), con il profilo descritto sotto.
12. **Log:** eventi e log con etichetta L2 contengono riferimenti (id, percorso, hash), mai il contenuto.

## Le cinque superfici d'uscita

Il controllo sul solo prompt non basta: un esecutore cloud apre i file da sé e chiama strumenti. Il gateway copre:

| Superficie | Rischio | Controllo |
| --- | --- | --- |
| Prompt e allegati verso un esecutore cloud | Frammento L2 nel testo | `gatewayCheck` sulle etichette + scanner deterministico |
| File che l'esecutore cloud può leggere | Legge fuori dal compito (home, `data/`, altri repository) | Confinamento: worktree, allowlist, sandbox, scansione preventiva |
| Strumenti MCP chiamati da una sessione cloud | `kb.read` restituisce una pagina L2 | Il server MCP conosce la clearance della sessione e nega sopra L1 |
| Canali esterni (Telegram, telefono, più avanti mail) | Arianna scrive un importo o un nome su Telegram | Stesso `gatewayCheck`, destinazione `channel` |
| Ricerche web da agenti locali | La query contiene dati L2 | Una sessione con `effective_label ≥ L2` non ha strumenti web |

## Conversazioni: lavoro e privato

Il nodo più delicato è l'orchestratore: è locale, legge L2 e scrive i brief per gli agenti cloud. Senza una regola, ogni brief sarebbe contaminato (regola 8) oppure porterebbe fuori dati privati.

- **Conversazione di lavoro** (`mode = work`, clearance L1): legata a un progetto approvato (D-058). L'orchestratore non può leggere L2 (la ricerca in KB privata è negata con un messaggio che invita ad aprire una conversazione privata). I brief nascono L1 ed escono senza approvazione.
- **Conversazione privata** (`mode = private`, clearance L2, predefinita): tutto resta locale. Se serve un esecutore cloud, il brief esatto ti viene mostrato in una scheda di approvazione ("esce verso Claude Code: …"); approvando lo declassifichi a L1 (regola 3) e solo quel testo esce.
- Il contesto dell'orchestratore è **per task**, non una sessione unica e lunga: un task L1 non eredita il contesto di una conversazione privata.

## Confinamento degli esecutori cloud

Profilo applicato da `packages/executors` a ogni lancio; i nomi esatti dei flag si verificano su `claude --help` e `codex --help` nei task 1.5 e 1.16 e si fissano nel test di contratto.

1. **Progetti approvati (D-058, prima `allowlist`):** il Coder lavora solo in una cartella elencata dall'utente nelle sezioni `[[project]]` di `arianna.toml` (nome, percorso, etichetta L0 o L1, predefinita L1). Il percorso è `~/...` sotto la home dell'utente oppure `repos/<nome>` dentro `ARIANNA_HOME`: mai la home stessa, cartelle nascoste (`.ssh`, `.config`...), `Library`, `ARIANNA_HOME` né cartelle dentro o attorno ad essa (salvo `repos/<nome>`), mai un progetto dentro un altro (anche per maiuscole). Cambiare la lista è un'impostazione di privacy: la scrive solo l'utente (wizard o a mano), mai un agente; il core la rilegge senza riavvio, e un progetto tolto chiude la delega al passo successivo. L'etichetta del progetto vale per tutti i suoi file: `labels.toml` non serve per i progetti. Una vecchia `[cloud] allowlist` non vuota è rifiutata con l'indicazione di passare ai `[[project]]`, mai convertita da sola. Una conversazione di lavoro nomina un progetto approvato per nome (in `conversations.workspace`; le conversazioni precedenti con `repos/<nome>` valgono come il progetto `<nome>`). Il link `repos/<nome>` che il wizard crea per un progetto sotto la home è solo una scorciatoia dell'utente: il Coder usa sempre il percorso approvato.
2. **Cartella di lavoro.** Per un progetto approvato il Coder lavora **nella cartella del progetto stessa** (D-056, scelta dell'utente: "come con la CLI di Claude Code"), sul branch corrente, senza copia: `openRepository` in `packages/executors` controlla a ogni lancio che il percorso approvato sia esattamente se stesso su disco (`realpath`: nessun link lungo il percorso, così un link cambiato dopo l'approvazione non sposta il Coder), che non contenga `ARIANNA_HOME` e vi stia dentro solo come `repos/<nome>`, e che sia la radice di un repository git; scansiona con `checkProject` (l'etichetta del progetto) i file tracciati e quelli non ignorati da git (un `.env` ignorato non blocca: l'utente lo mostra già a Claude Code quando lo lancia lui), e con modifiche non committate chiede l'approvazione `workspace` dalla chat (legata ai file che nomina: un file sporcato dopo il sì viene richiesto). **Rischi residui accettati con D-056:** nella cartella vera la `.git` (storia, configurazione, hook) è leggibile e scrivibile dal Coder, come lo è quando l'utente lancia Claude Code lì; per questo ogni comando git di Arianna in quella cartella gira con un ambiente minimo (nessun segreto del core), senza hook, fsmonitor, configurazione globale né lock facoltativi, e usa solo comandi che non convertono contenuti attraverso i filtri (`ls-files`, `diff-index --cached`, mai `git status`); un'impronta di `.git`, `.git/config`, hook, `info/attributes` e di ogni `.gitattributes` è presa prima del run e confrontata dopo: se cambia, la delega fallisce con un messaggio esplicito e nessun comando git di Arianna gira lì finché l'utente non ha guardato. I comandi git dell'utente, invece, eseguono ciò che il Coder ha lasciato in `.git`: è la stessa esposizione dell'uso diretto della CLI. Un repository annidato o un sottomodulo è una voce speciale che blocca il lancio (i loro file non sono scansionati); un link simbolico ignorato da git non è scansionato. La **copia dedicata** per run, in `data/worktrees/<run>` (`prepareWorkspace`), resta per gli eval e per usi fuori allowlist: non un `git worktree`, il cui file `.git` porterebbe l'esecutore a tutta la storia del repository d'origine (segreti cancellati compresi) e alla sua cartella `.git` scrivibile (hook e configurazione eseguiti poi fuori dalla sandbox). I file di un commit si scrivono così come sono nel database degli oggetti (`git ls-tree` e `git cat-file`: nessun filtro, hook o fsmonitor eseguito; senza configurazione globale o di sistema; percorsi con `..` o `.git` e file sotto un collegamento simbolico rifiutati; sottomoduli non estratti), poi si crea lì un repository nuovo con un solo commit, perché l'esecutore possa fare diff. Il repository in allowlist dev'essere una cartella vera, non un collegamento simbolico. La directory di lavoro del processo è quella cartella; se la scansione blocca, viene rimossa subito. Riportare le modifiche nel repository d'origine spetta al chiamante (1.10).
3. **Scansione preventiva** (`checkWorkspace` in `packages/policy`, pura; la lettura del disco è `scanWorkspace` per la copia, `openRepository` per la cartella del progetto, che salta i file ignorati da git): il lancio è negato se la cartella di lavoro contiene file sopra L1 secondo le regole per cartella applicate al percorso nel repository d'origine (non a `data/worktrees`, che è L2), file di segreti, anche quando il nome da segreto è una cartella del percorso (`.env`, `.env.*`, `*.env`, `.envrc`, `.netrc`, `.npmrc`, `.pgpass`, `.pypirc`, `.htpasswd`, `.dockercfg`, `.git-credentials`, `credentials`, `credentials.json`, `terraform.tfstate`; `*.pem`, `*.key`, `*.p8`, `*.p12`, `*.pfx`, `*.age`, `*.jks`, `*.keystore`, `*.kdbx`, `*.gpg`, `*.tfvars`, `*.tfstate`; chiavi SSH private `id_rsa*`, `id_dsa*`, `id_ecdsa*`, `id_ed25519*` tranne `.pub`; cartelle `.ssh`, `.gnupg`, `.aws`, `.kube`, `.docker`; nomi confrontati senza maiuscole), collegamenti simbolici con bersaglio assoluto, che escono dalla cartella anche solo per un passo o non si risolvono (quelli interni valgono per il loro bersaglio), file speciali o percorsi malformati. Il contenuto dei file non si legge: i dati finti dei test (IBAN di prova) bloccherebbero ogni repository.
4. **Permessi:** elenco chiuso di strumenti (`--tools` e `--allowedTools`), modalità non interattiva che nega ciò che non è in elenco (`--permission-mode dontAsk`, `--permission-prompts none`). Per `claude` (D-049) l'elenco ammesso è `Read`, `Glob`, `Grep`, `Edit`, `Write`: `Bash`, `WebFetch` e `WebSearch` solo dopo la sandbox (punto 6).
5. **Nessuna configurazione ereditata:** solo i server MCP di Arianna (`--mcp-config` con `--strict-mcp-config`), senza impostazioni, hook o connettori del tuo profilo utente. Un `claude -p` che eredita i tuoi connettori personali (posta, drive) sarebbe una fuga. Per `claude` (D-049): `--mcp-config` vuoto finché non c'è il server MCP di Arianna (1.6), `--restricted`, `--safe-mode`, `--disable-slash-commands`, `--no-chrome`; il messaggio `init` del binario si confronta con il profilo (strumenti, MCP, skill, plugin solo incorporati, abbonamento e non API key) e il run si ferma se non torna.
6. **Sandbox del sistema operativo:** letture negate fuori dal worktree e dalla toolchain, rete limitata al fornitore del modello e ai registri dei pacchetti. Negate anche le connessioni via loopback ai servizi di Arianna (database, Qdrant, modello locale), che altrimenti sarebbero un'uscita L2 senza gateway; resta ammesso solo il server MCP di Arianna. Per `claude` (D-050): sandbox nativa di Claude Code passata con `--settings`, senza rete né loopback, senza tentativi fuori sandbox; letture negate nelle cartelle utente, in `ARIANNA_HOME` e nelle cartelle temporanee condivise, riaperte solo per worktree, `bin`/`lib` di Node e la cartella temporanea del binario; restano leggibili le cartelle di sistema (`/usr`, `/etc`, `/opt`…). `Bash` ammesso solo con essa. Il server MCP di Arianna arriva con il 1.10: fino ad allora nessuno.
7. **Ambiente pulito:** nessuna variabile con segreti ereditata. Arianna non legge mai l'archivio delle credenziali dei binari. Per `claude` (D-049) passano solo `PATH`, `HOME`, `USER`, `LOGNAME`, `TMPDIR`, più `LANG` e `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`; il prompt va su stdin, non fra gli argomenti visibili con `ps`.
8. **Canarino:** un file finto L2 con una stringa unica fuori dal worktree, e la stessa stringa in una riga finta del database; il test dal vivo chiede all'esecutore di leggerli e verifica che la stringa non compaia nel transcript (`EVALS.md`). Per `claude` (D-050) la riga del database è un servizio finto su 127.0.0.1 che risponde con la stringa: stesso canale, senza toccare il database vero.

"Locale" non è una proprietà del binario ma di dove avviene l'inferenza: un esecutore è locale solo se il suo endpoint è fra i `[[local.endpoints]]` di `arianna.toml`, che per ora ammettono solo indirizzi di loopback (D-033). Codex con un provider locale conta come locale solo dopo aver verificato che non invii telemetria o contenuti altrove (`OPEN-QUESTIONS.md`); fino ad allora il codice L2 si lavora con il modello locale.

## Da dove vengono le etichette

| Sorgente | Etichetta |
| --- | --- |
| Regole per cartella e sorgente (`config/labels.toml`) | Quella della regola |
| Intestazione della pagina KB (`label:`) | Quella dichiarata, mai sotto la regola di cartella |
| Messaggio dell'utente | Clearance della conversazione |
| Output di un modello o di uno strumento | Massimo degli input (taint) |
| Risultato di un esecutore cloud | Massimo degli input inviati (quindi ≤ L1) |
| Tutto il resto | L2 |

### Regole per cartella e sorgente (`config/labels.toml`, D-031)

```toml
[[folder]]
path = "kb/private"        # relativo ad ARIANNA_HOME
label = "L2"

[[folder]]
path = "kb/private/shared"
label = "L1"               # la regola più specifica vince, anche se abbassa

[[source]]
name = "web"
label = "L0"
```

- Vince la regola di cartella più specifica (prefisso di cartella più lungo, per segmenti interi: `kb/pub` non contiene `kb/public`). L'ordine nel file non conta.
- Un file che nessuna regola contiene è L2; una sorgente senza regola è L2.
- Rifiutati al caricamento: percorsi assoluti o fuori da `ARIANNA_HOME`, una regola per tutta `ARIANNA_HOME` (spegnerebbe il default-deny), regole doppie anche se scritte diversamente (`kb/work`, `./KB/Work/`), etichette non valide, chiavi sconosciute.
- **Maiuscole e Unicode:** l'etichetta di un percorso si calcola due volte, una con le maiuscole esatte e una senza distinzione di maiuscole, sempre con i nomi in NFC, e vale la più alta. Su un disco che ignora le maiuscole `Data/Vault/x` resta L3; su un disco che le distingue `KB/Public/x` non eredita L0.
- I collegamenti simbolici non si risolvono nelle regole: chi legge un file ne etichetta il percorso reale, e la scansione preventiva (task 1.6) li tratta a parte. Un percorso con un segmento `..` viene rifiutato: dopo un collegamento punterebbe altrove, e un percorso reale non ne contiene.
- **Intestazione della pagina KB:** assente (o vuota come `null`) vuol dire nessuna intestazione; presente ma non valida (`l3`, `L3 `) vale L3, perché leggerla come L2 potrebbe declassare un segreto.
- Cambiare il file è un'impostazione di privacy: lo modifica solo l'utente.

## Scanner deterministico

Difesa in profondità, non controllo primario: ogni payload verso cloud o canale esterno passa da espressioni regolari per IBAN, codice fiscale, numeri di carta, chiavi private e token noti. Un riscontro blocca l'uscita anche se l'etichetta dice L1: verso un esecutore o il web porta il task in "Attende te", verso un canale esterno diventa una notifica con riferimento.

- Un valore strutturato si controlla stringa per stringa (chiavi, testi e numeri del JSON già decodificato): nella forma JSON un a capo diventa `\n` e la `n` nasconderebbe l'inizio di un IBAN.
- I confini di un riscontro sono lettere e cifre, non `\b`: `iban_IT60…` viene trovato.
- Il testo si normalizza prima (NFKC, caratteri invisibili tolti): cifre a larghezza piena o spazi di larghezza zero non nascondono un riscontro.
- Si preferisce un falso allarme a una fuga, con due eccezioni dove una somma di controllo tiene fuori hash e identificativi comuni: l'IBAN deve superare il mod-97 (raggruppato a quattro, si riprova togliendo gruppi finali, che potrebbero essere la parola successiva), il numero di carta (cifre separate da spazi, punti o trattini) il controllo di Luhn e iniziare per 2-6 (i timestamp in millisecondi iniziano per 1). Il codice fiscale si riconosce dalla forma, anche con omocodia, senza verificare il carattere di controllo.
- Token riconosciuti: chiavi PEM private e chiavi `age`, AWS, GitHub, GitLab, chiavi `sk-` (Anthropic, OpenAI), Stripe, Slack, Google, bot Telegram, npm, JWT, password dentro un URL.
- Un riscontro riporta tipo e posizione, mai il testo trovato: la ragione del blocco finisce nel log.
- Un valore che non è testo né JSON semplice (funzioni, istanze di classi, cicli) non si può controllare e viene bloccato.

## Come decide il gateway (task 1.2, D-032)

`gatewayCheck` controlla in quest'ordine e si ferma al primo blocco: input ben formati (contesto creato dalla policy, destinazione nota, lista di frammenti) → nessun frammento L3, verso nessuna destinazione → destinazioni locali (modello locale, chat web) fino a L2 → destinazioni cloud (esecutori cloud, Telegram, telefono, ricerca web) solo con contesto a `effective ≤ L1`, payload ≤ L1 e scansione pulita.

- **Il contesto** è quello della sessione a cui il payload appartiene dal lato di chi invia: il run per il brief di un esecutore cloud, il task per un messaggio su un canale o una ricerca web. Un brief declassato esce da un run nuovo, che ha letto solo quel brief.
- **Avvisi scritti dal canale (D-044):** l'avviso di un'approvazione su Telegram non lo scrive il task ma il canale, da dati L0 (il nome dell'azione dalla lista chiusa, i testi fissi dei pulsanti) e, solo se il task è al massimo L1, dal titolo del task. Il suo contesto è quindi quello di ciò che ha letto: `effective` pari all'etichetta del titolo, o L0 senza titolo, anche quando il task ha letto L2. È l'unica eccezione alla regola del contesto del task: `detail` non vi entra mai, e la risposta del task verso Telegram resta giudicata nel contesto del task.
- **Contesto non falsificabile:** il gateway accetta solo contesti restituiti da `createContext` o `recordRead`; un oggetto con la stessa forma, o letto da JSON, è bloccato. Chi crea il contesto giusto per un run resta compito del core.
- **Dopo un blocco** la decisione dice cosa fare (`next`): un canale esterno riceve una notifica con riferimento (`notify-reference`); un riscontro dello scanner verso un esecutore porta il task in "Attende te" (`wait-user`); negli altri casi il lavoro resta locale, oppure l'utente approva il testo esatto (`stay-local`).
- **Testo congelato:** una decisione `allow` porta `texts`, il testo esatto controllato per ogni frammento, serializzato una sola volta e congelato. Gli adattatori inviano quello, mai una nuova serializzazione dei valori originali, che potrebbero essere cambiati dopo il controllo.
- **Log:** `passGateway` (`apps/core`) scrive ogni decisione in `gateway_log`, consentita o bloccata, locale o cloud, e solo dopo si può inviare: se il log non si scrive, non esce nulla. Unica eccezione: una destinazione non valida non ha una riga possibile (manca il tipo), e il blocco torna al chiamante senza log. La ragione contiene etichette e regole, mai contenuto; il riassunto si salva solo per uscite consentite fino a L1 e se lo scanner non vi trova nulla.
- **Declassamento:** `declassifyRequest` prepara l'approvazione (testo esatto, suo sha256, etichetta di partenza e di arrivo); `declassify` abbassa l'etichetta solo con un'approvazione `declassify` approvata per quello stesso testo e quelle stesse etichette, e restituisce la riga per `label_changes` (`subject = content:<sha256>`). L3 non si declassa mai. Un'approvazione vale una volta sola, e un declassamento si decide solo dalla chat web: la scheda mostra il testo, che può essere L2, quindi né Telegram né il telefono possono mostrarlo. Il database ricontrolla tutto con vincoli e trigger, compreso che lo sha256 sia quello del testo mostrato.
- **Località:** `claude` e `codex` sono sempre cloud: dichiararli locali è un errore e blocca. Per gli altri esecutori il gateway si fida della `locality` dichiarata; che siano davvero locali lo garantiscono gli adattatori: quello del modello locale (task 1.3, D-033) accetta solo indirizzi di loopback, non segue redirect e non passa mai da un proxy, nemmeno se l'ambiente ne configura uno. Codex con un provider locale (`OPEN-QUESTIONS.md`) richiederà di cambiare questa regola, con una decisione.

## Interfaccia (bozza)

```ts
type Label = 'L0' | 'L1' | 'L2' | 'L3';
type Target =
  | { kind: 'executor'; id: ExecutorId; locality: 'local' | 'cloud' }
  | { kind: 'channel'; id: 'web' | 'telegram' | 'phone' }
  | { kind: 'web' };
interface Labeled<T> { value: T; label: Label; source: string }
interface Context { clearance: Label; effective: Label } // per conversation, task and run

function maxLabel(...l: Label[]): Label;
function derive(inputs: Labeled<unknown>[]): Label;       // taint: max of inputs; no inputs -> L2
function canRead(ctx: Context, label: Label): boolean;     // label <= clearance, never L3
function recordRead(ctx: Context, label: Label): ReadResult; // allowed -> effective rises; denied -> ctx unchanged
function canUseCloud(ctx: Context): boolean;               // effective <= L1 (also canUseWebTools)
function createContext(clearance: Label, effective?: Label): Context; // clearance never L3
function clearanceFor(mode: 'work' | 'private'): Label;    // L1 | L2
function labelForUserMessage(ctx: Context): Label;         // = clearance
function recordUserMessage(ctx: Context): Context;         // the message is a read of the clearance
function isContext(value: unknown): value is Context;      // only contexts made by the policy
function createLabelRules(input: { folders: FolderRule[]; sources: SourceRule[] }): LabelRules;
function labelForPath(rules: LabelRules, path: string): Label;   // folder rules, default L2; ".." rejected
function labelForKbPage(rules: LabelRules, path: string, declared: unknown): Label; // header only raises; invalid -> L3
function labelForSource(rules: LabelRules, name: string): Label; // default L2
function canSendTo(locality: 'local' | 'cloud', label: Label): boolean;
function gatewayCheck(payload: Labeled<unknown>[], ctx: Context, target: Target): Decision;
  // { decision: 'allow', rule, label, reason, texts } | { decision: 'block', rule, label, reason, next, findings? }
function scanText(text: string): Finding[];               // { kind, name, index }, never the matched text
function checkWorkspace(input: { repo: string; allowlist: string[]; entries: WorkspaceEntry[]; rules: LabelRules }): WorkspaceDecision; // allowlist + pre-flight scan (task 1.6), for the copies of the evals
function checkProject(input: { label: Label; entries: WorkspaceEntry[] }): WorkspaceDecision; // an approved project folder (D-058)
function declassifyRequest(item: Labeled<unknown>, to: Label): { text: string; sha256: string; from: Label; to: Label };
function declassify<T>(item: Labeled<T>, to: Label, approval: DeclassifyApproval): { item: Labeled<T>; change: LabelChange };
```

## Test minimi (vedi `EVALS.md`, gruppo "gateway")

Ogni regola ha almeno un caso positivo e uno negativo.

- Payload con un solo frammento L2 verso cloud → bloccato; payload tutto L1 → consentito e registrato.
- Dato senza etichetta verso cloud → bloccato.
- Sessione contaminata che chiede un esecutore cloud → rifiutata.
- Abbassamento di etichetta senza approvazione → rifiutato; con approvazione → consentito e registrato.
- Ogni uscita consentita produce una riga di log.
- L3 mai presente nel testo di un prompt.
- Riassunto di un documento L2 → L2 (taint).
- Lettura L2 in conversazione di lavoro → negata, `effective_label` invariata.
- Messaggio con contenuto L2 verso Telegram → sostituito da notifica con riferimento.
- Worktree fuori allowlist o con `.env` → lancio negato.
- Strumento MCP chiamato da sessione cloud su indice L2 → negato.
- IBAN finto in un payload etichettato L1 → bloccato dallo scanner.
