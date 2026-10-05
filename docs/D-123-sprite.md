# D-123 — Personaggio generato da un modello: disegno

Disegno della decisione D-123 (`docs/DECISIONS.md`), scritto prima del codice. Riprende il formato dei personaggi di D-060 (foglio di pixel-agents, 112×128 con la quarta riga) e il pacchetto `miei` di D-118.

## In breve

1. Nella chat (passo "Aspetto" di Nuovo agente, e scheda dell'agente in Impostazioni → Agenti) l'utente preme **Genera personaggio**, con un suggerimento facoltativo ("capelli verdi, felpa gialla").
2. La pagina chiama `POST /api/characters/generate` con nome, descrizione, prompt dell'agente e suggerimento. Il core li controlla (scanner e vault, come i testi degli agenti utente), aggiunge tono e specializzazione di `[personas.<nome>]` se ci sono, compone il brief (parte fissa L0 + parte variabile L1), lo passa dal gateway e chiede il disegno al modello del ruolo **personaggi**.
3. Il modello risponde con un **JSON di pezzi e palette**. Il codice lo valida tutto, ricava le pose (camminata, scrittura, lettura, pensa, aspetta, pausa) dai pezzi, compone le 28 caselle con `apps/hud/characters/compose.ts` e scrive il PNG 112×128 con il codificatore senza dipendenze (`node:zlib`).
4. La risposta porta il PNG in base64 (niente scritto su disco) e il modello che l'ha disegnato. La pagina mostra l'anteprima (PixelAgent in posa idle e working, più il foglio con le animazioni) con **Rigenera** e **Tieni**.
5. Solo **Tieni** salva: la pagina manda quel PNG alla rotta di caricamento di D-118 (`POST /api/characters/upload`), che lo decodifica, lo riscrive e lo mette nel pacchetto `miei`, con la stessa conferma se il nome esiste già. Poi il personaggio si sceglie per l'agente come dopo un caricamento.

## Schema JSON della risposta

Un oggetto con esattamente quattro campi, niente altro a nessun livello:

```json
{
  "palette": { "o": "#1a1c2c", "e": "#1b1b2a", "E": "#c98f6c", "s": "#f2c6a0", "h": "#8a3b2a", "d": "#2fb3a3" },
  "head": { "front": ["16 caratteri", "… 10 righe"], "side": ["… 10 righe"], "back": ["… 10 righe"] },
  "body": { "front": ["… 9 righe"], "side": ["… 9 righe"], "back": ["… 9 righe"] },
  "legs": { "front": ["… 6 righe"], "side": ["… 6 righe"], "stride": ["… 6 righe"] }
}
```

Regole (il codice rifiuta tutto il resto, con un motivo che nomina il campo e mai il contenuto):

| Campo | Regola |
| --- | --- |
| `palette` | da 4 a 16 voci; chiave una lettera ASCII (`a-z`, `A-Z`), valore `#rrggbb`. Obbligatorie `o` (contorno), `e` (occhi), `E` (occhi chiusi o palpebra), `s` (pelle o mani). `.` è il trasparente e non sta in palette |
| `head.*` | 10 righe (righe 7–16 del fotogramma) |
| `body.*` | 9 righe (17–25) |
| `legs.*` | 6 righe (26–31) |
| ogni riga | esattamente 16 caratteri, ciascuno `.` o una lettera della palette |
| `head.front`, `head.side` | almeno un pixel `e` (gli occhi: le pose li spostano) |
| `head.back` | nessun `e` (di spalle gli occhi non si vedono) |
| ogni pezzo | almeno 8 pixel non trasparenti |
| testo | al massimo 16 KiB; JSON valido (un blocco ```` ```json ```` attorno è tollerato e tolto) |

Le misure e le righe sono quelle di Arianna e del Coder (`apps/hud/characters/art/`): testa 7–16, corpo 17–25, gambe 26–31; le righe 0–6 restano vuote.

## Pose ricavate dal codice

Il modello disegna 9 pezzi; il resto lo fa `apps/core/src/sprites/spec.ts`, in modo deterministico (stesso JSON, stesso PNG), e lo passa a `renderSheet` di `compose.ts`, che risolve i nomi mancanti col pezzo base (`head-work` → `head`).

| Direzione | Pezzo | Come |
| --- | --- | --- |
| giù | `head` | `head.front` |
| giù | `head-blink`, `head-sleep` | `e` → `E` |
| giù | `head-work`, `head-read` | occhi un pixel più in basso |
| giù | `head-read2` | occhi in basso e a sinistra |
| giù | `head-up`, `head-up2` | occhi in alto; in alto e a destra |
| giù | `body`, `body-type`, `body-type2` | `body.front`; mani `s` sulla riga 4–5, alternate |
| giù | `body-read`, `body-read2` | un foglio (colori nostri `1` e `2`) fra le mani, la riga cambia |
| giù | `body-think` | una mano al mento |
| giù | `over-wait`, `over-wait2` | il braccio alzato (forma di Arianna, colori `o` e `s`) |
| giù, su | `legs`, `legs-step1`, `legs-step2` | `legs.front`; metà sinistra o destra sollevata di un pixel |
| su | `head`, `body` | `head.back`, `body.back` |
| destra | `head`, `head-blink`, `head-work` | `head.side`, come sopra |
| destra | `body`, `body-type*`, `body-read*` | `body.side`; mani o foglio davanti |
| destra | `legs`, `legs-step1`, `legs-step2` | `legs.side`, `legs.stride`, `legs.stride` |

Uno spostamento degli occhi che finirebbe su un contorno, sul trasparente o fuori dalla testa non si fa (la posa resta quella base). La sinistra è la destra specchiata, come per tutti i personaggi. I colori `1` (`#f4ecd8`) e `2` (`#c9b98f`) del foglio sono del codice: la palette del modello ha solo lettere, quindi non li tocca.

## Prompt

**Parte fissa, L0** (`SPRITE_PROMPT` in `apps/core/src/sprites/prompt.ts`, in inglese come gli altri prompt): cosa disegnare, griglia e righe, lettere obbligatorie, regole dello stile pixel di Arianna e Coder (contorno scuro `o` di un pixel, 3–6 colori più ombre, niente sfumature, simmetria nella vista di fronte, testa grande), schema di risposta e un esempio completo (i pezzi di Arianna presi da `art/arianna.ts`, che il validatore accetta). È una costante: identica byte per byte a ogni richiesta, e un test ne fissa lo sha256 (cambiarla è una scelta, da rivedere).

**Parte variabile, L1 per dichiarazione dell'utente**, un frammento per campo, ciascuno con la sua sorgente:

| Frammento | Sorgente | Etichetta |
| --- | --- | --- |
| `Agent name: …` | `agent:<nome>:name` | L1 |
| `Description: …` | `agent:<nome>:description` | L1 |
| `Agent prompt: …` (facoltativo, al massimo 4000 caratteri) | `agent:<nome>:prompt` | L1 |
| `Tone: …` (da `[personas]`, se c'è) | `persona:<nome>:tone` | L1 |
| `Specialization: …` (da `[personas]`, se c'è) | `persona:<nome>:specialization` | L1 |
| `User hint: …` (facoltativo, al massimo 300 caratteri) | `user:sprite-hint` | L1 |

Prima del gateway il core controlla ogni testo con lo scanner e con i valori del vault (`checkText` come per gli agenti utente): un ritrovamento rifiuta la richiesta con 400, nominando il campo e il tipo, mai il testo. Il gateway li ricontrolla verso il cloud (scansione pulita, al massimo L1, nessun valore del vault) e scrive la riga in `gateway_log`.

## Modello: ruolo "personaggi"

`arianna.toml`, tabella nuova, impostazione ordinaria (non apre uscite: Claude deve già essere attivo in `[cloud] executors`):

```toml
[sprites]
model = "sonnet"   # "sonnet" (predefinito), "opus" o "local"
```

In Impostazioni → Modelli per ruolo una riga "Personaggi" con tre scelte: Claude Sonnet (predefinito), Claude Opus, modello locale. Se il modello scelto non è disponibile (Claude non attivo o il modello spento in `[cloud.models]`; per il locale nessun endpoint) la rotta risponde 409 e la pagina lo dice, senza ripiegare da sola su un altro modello.

- **Claude**: `passGateway` verso `{ kind: 'executor', id: 'claude', locality: 'cloud' }` con contesto `createContext('L1', etichetta più alta dei frammenti)`, poi `executor.start` di `packages/executors` in una cartella vuota (`prepareEmptyWorkspace`, tolta dopo), **senza strumenti** (`tools: []`), al massimo 3 turni, 4 minuti. Stessa strada di Claude diretto (D-064), senza task: il brief è l'allow del gateway. L'uscita strutturata è il JSON chiesto dal prompt fisso e validato dal codice; il flag `--json-schema` del binario non si usa ancora, perché aggiunge uno strumento interno che il profilo di confinamento rifiuterebbe (il controllo di `init` vuole `tools` vuoto) e va prima provato con un eval dal vivo.
- **Locale**: `passGateway` verso `{ kind: 'executor', id: 'local', locality: 'local' }`, poi `createLocalModel().chat` sull'alias `local-large` con lo schema JSON vincolato (`SPRITE_SCHEMA`, lo stesso schema del validatore), temperatura 0,7.

Una risposta che non passa la validazione dà 502 con il motivo (campo e regola). Il quota di Claude esaurito dà 429 con l'ora di ripresa se nota.

## Rotte

| Rotta | Corpo | Risposta |
| --- | --- | --- |
| `GET /api/characters/generate` | — | `{ model: "sonnet"\|"opus"\|"local", available: boolean, reason?: string, sends: ["name","description","prompt","tone","specialization","hint"] }`: cosa disegna e cosa esce, per la pagina |
| `POST /api/characters/generate` | `{ name, description, prompt?, hint? }`, nessun altro campo | 200 `{ png: base64, rows: 4, model, label: "L1" }`; 400 testo rifiutato; 409 modello non disponibile; 429 quota; 502 risposta non valida o modello che non risponde; 403 gateway che blocca |
| `POST /api/characters/upload` | come D-118 | invariata: "Tieni" la usa |

Una sola generazione alla volta: una seconda richiesta mentre la prima corre risponde 409 ("sto già disegnando").

## Etichette

- Parte fissa L0; testi dell'agente, persona e suggerimento L1 per dichiarazione (D-107, D-119). Nessun dato L2 entra: i testi vengono dalla pagina o da `[personas]`, mai dalla knowledge base o dalle conversazioni.
- Il PNG generato eredita L1 (l'uscita di un modello eredita l'etichetta più alta degli ingressi), che è il tetto dei personaggi caricati: sta in `data/characters/miei`, servito solo alla chat locale.

## Casi di test

- **Validazione** (`apps/core/test/sprites.test.ts`): l'esempio del prompt passa; rifiutati con il motivo giusto: riga di 15 o 17 caratteri, pezzo con 9 o 11 righe, lettera fuori palette, chiave di palette di due lettere o cifra, colore `#abc` o `red`, palette senza `e` o senza `o`, palette con 17 voci, campo in più in cima, in `head` o in `legs`, `head.back` con occhi, `head.front` senza occhi, pezzo vuoto, testo non JSON, JSON in un blocco di codice (accettato), testo oltre 16 KiB.
- **Composizione deterministica**: stesso JSON → stesso PNG byte per byte; il PNG è 112×128 e si decodifica con `decodePng`; occhi chiusi nel fotogramma della pausa; `cleanSheet` di D-118 lo accetta.
- **Prompt fisso**: identico a ogni chiamata, sha256 fissato nel test; non contiene nessun testo dell'agente.
- **Parte variabile**: un frammento per campo con sorgente ed etichetta L1; persona solo quando c'è; suggerimento vuoto assente.
- **Gateway**: un suggerimento con un IBAN o un codice fiscale è bloccato verso Claude (`gatewayCheck`, regola di scansione); un valore del vault è bloccato verso qualunque destinazione; un brief pulito passa con etichetta L1.
- **Scelta del modello**: `[sprites]` assente → sonnet; `opus`, `local`; valore sconosciuto o chiave in più rifiutati da `parseConfig`; la pagina delle impostazioni lo legge e lo scrive come impostazione ordinaria.
- **Rotte con Claude finto** (`apps/core/test/sprites-route.test.ts`, binario finto in `apps/core/test/support/fake-claude-sprite.ts`): JSON valido → 200 con PNG; JSON rotto → 502; suggerimento con dato personale → 400 e il binario non parte; Claude non attivo → 409; campo in più → 400; modello locale finto (`fake-omlx`) → 200 con lo schema vincolato nella richiesta.

## Scostamenti dalla riga D-123 (da riportare in DECISIONS)

- **Uscita strutturata di Claude**: oggi è il JSON chiesto dal prompt fisso e validato dal codice, non il flag `--json-schema` (vedi sopra). Il modello locale usa invece lo schema vincolato.
- **Eval di validità**: non c'è ancora un eval dei modelli; la validità è coperta dai test deterministici del validatore e delle rotte con Claude finto. Un eval `eval:live` che chieda un disegno vero e ne misuri la percentuale valida è il passo successivo.
- **Il core importa due file della chat**: `apps/core/src/sprites/` importa `apps/hud/characters/compose.ts` e `art/arianna.ts` (codice puro, senza Vue). Finora la dipendenza andava solo dalla chat al core (il codificatore PNG è duplicato apposta); qui si è scelto di non duplicare la composizione delle pose. In alternativa si possono spostare in un pacchetto comune.

## Limiti noti

- L'uso di Claude per i personaggi non passa dal router: niente scala dei modelli né attesa del quota; i limiti di frequenza che il binario riporta non entrano negli eventi del budget (non c'è un task a cui legarli).
- Le pose ricavate sono semplici (mani e foglio di pochi pixel): per un personaggio curato resta il disegno a mano o il PNG caricato.
- Consuma quota: ogni "Genera" o "Rigenera" con Sonnet o Opus è una richiesta al tuo abbonamento Claude (una risposta di circa 2–3 mila token).
