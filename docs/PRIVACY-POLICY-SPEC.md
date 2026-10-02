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
6. **Segreti (L3):** mai nel prompt; solo riferimenti (`vault://nome`) risolti dal processo che li usa. Gestione con `sops` + `age`.
7. **Voce:** la telefonia aggiunge un percorso audio nel cloud, quindi nessuna lettura di L2 ad alta voce salvo abilitazione per quella singola chiamata.
8. **Taint (D-015):** l'output di un modello ha l'etichetta più alta fra i suoi input. Un riassunto, un piano o un brief scritto da un modello che ha letto L2 è L2, anche se "sembra" innocuo.
9. **Clearance (D-015):** ogni conversazione, task e run ha un tetto (`clearance`) e un'etichetta effettiva (`effective_label`, il massimo di ciò che ha letto davvero). Una lettura sopra il tetto è negata, non contamina. Un esecutore cloud è ammesso solo se `effective_label ≤ L1`.
10. **Canali esterni (D-016):** Telegram e telefono sono destinazioni cloud come Claude Code. Ricevono al massimo L1; un contenuto L2 diventa una notifica con riferimento ("hai una carta in attesa, apri la chat web"). Solo la chat web raggiunta via VPN è un canale locale.
11. **Confinamento degli esecutori cloud (D-014):** un processo `claude` o `codex` vede solo il proprio worktree, in un repository in allowlist, con il profilo descritto sotto.
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

- **Conversazione di lavoro** (`mode = work`, clearance L1): legata a un repository in allowlist. L'orchestratore non può leggere L2 (la ricerca in KB privata è negata con un messaggio che invita ad aprire una conversazione privata). I brief nascono L1 ed escono senza approvazione.
- **Conversazione privata** (`mode = private`, clearance L2, predefinita): tutto resta locale. Se serve un esecutore cloud, il brief esatto ti viene mostrato in una scheda di approvazione ("esce verso Claude Code: …"); approvando lo declassifichi a L1 (regola 3) e solo quel testo esce.
- Il contesto dell'orchestratore è **per task**, non una sessione unica e lunga: un task L1 non eredita il contesto di una conversazione privata.

## Confinamento degli esecutori cloud

Profilo applicato da `packages/executors` a ogni lancio; i nomi esatti dei flag si verificano su `claude --help` e `codex --help` nei task 1.5 e 1.16 e si fissano nel test di contratto.

1. **Allowlist:** il repository è in `cloud_allowlist` di `arianna.toml`. Cambiare la lista è un'impostazione di privacy: conferma esplicita, mai da un agente.
2. **Worktree dedicato** per ogni run, in `data/worktrees/`; la directory di lavoro del processo è il worktree.
3. **Scansione preventiva:** il lancio è negato se il worktree contiene file L2 secondo le regole per cartella, o file di segreti (`.env*`, `*.pem`, `*.age`, chiavi).
4. **Permessi:** elenco chiuso di strumenti (`--allowedTools`), modalità non interattiva che nega ciò che non è in elenco.
5. **Nessuna configurazione ereditata:** solo i server MCP di Arianna (`--mcp-config` con `--strict-mcp-config`), senza impostazioni, hook o connettori del tuo profilo utente. Un `claude -p` che eredita i tuoi connettori personali (posta, drive) sarebbe una fuga.
6. **Sandbox del sistema operativo:** letture negate fuori dal worktree e dalla toolchain, rete limitata al fornitore del modello e ai registri dei pacchetti. Negate anche le connessioni via loopback ai servizi di Arianna (database, Qdrant, modello locale), che altrimenti sarebbero un'uscita L2 senza gateway; resta ammesso solo il server MCP di Arianna. Candidati: sandbox nativa di Claude Code o `sandbox-runtime` (idea 2).
7. **Ambiente pulito:** nessuna variabile con segreti ereditata. Arianna non legge mai l'archivio delle credenziali dei binari.
8. **Canarino:** un file finto L2 con una stringa unica fuori dal worktree, e la stessa stringa in una riga finta del database; il test dal vivo chiede all'esecutore di leggerli e verifica che la stringa non compaia nel transcript (`EVALS.md`).

"Locale" non è una proprietà del binario ma di dove avviene l'inferenza: un esecutore è locale solo se il suo endpoint è in `local_endpoints`. Codex con un provider locale conta come locale solo dopo aver verificato che non invii telemetria o contenuti altrove (`OPEN-QUESTIONS.md`); fino ad allora il codice L2 si lavora con il modello locale.

## Da dove vengono le etichette

| Sorgente | Etichetta |
| --- | --- |
| Regole per cartella e sorgente (`config/labels.toml`) | Quella della regola |
| Intestazione della pagina KB (`label:`) | Quella dichiarata, mai sotto la regola di cartella |
| Messaggio dell'utente | Clearance della conversazione |
| Output di un modello o di uno strumento | Massimo degli input (taint) |
| Risultato di un esecutore cloud | Massimo degli input inviati (quindi ≤ L1) |
| Tutto il resto | L2 |

## Scanner deterministico

Difesa in profondità, non controllo primario: ogni payload verso cloud o canale esterno passa da espressioni regolari per IBAN, codice fiscale, numeri di carta, chiavi private e token noti. Un riscontro blocca l'uscita e porta il task in "Attende te", anche se l'etichetta dice L1.

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
function derive(inputs: Labeled<unknown>[]): Label;       // taint: max of inputs
function canRead(ctx: Context, label: Label): boolean;     // label <= clearance, never L3
function canSendTo(target: Target, label: Label): boolean;
function gatewayCheck(payload: Labeled<unknown>[], ctx: Context, target: Target): Decision; // allow | block + reason
function checkWorkspace(dir: string, target: Target): Decision; // allowlist + pre-flight scan
function declassify<T>(item: Labeled<T>, to: Label, approvalId: string): Labeled<T>;
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
