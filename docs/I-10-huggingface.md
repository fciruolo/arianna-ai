# I-10 — Modelli da Hugging Face dalla pagina "Modelli"

Progetto dell'idea I-10 di `docs/PROPOSTE.md`, detta dall'utente alla prova di I-3 (2026-10-07): "cercare i modelli su Hugging Face dalla pagina Modelli e scaricare quelli scelti". Decisione: **D-139**. Scritto e applicato il 2026-10-07 mentre l'utente era via: le scelte qui sotto sono le opzioni consigliate, da confermare (domanda `oq-modelli-da-hugging-face-scelte-di-d-139` in `docs/OPEN-QUESTIONS.md`).

## Com'era

Il catalogo dei modelli locali (`config/models.catalog.yaml`, in git) è scritto a mano: ogni file ha un URL a commit fisso e lo sha256. La pagina Modelli (I-3, D-137) scarica solo da quegli URL, e D-137 diceva che il core non legge mai pagine di Hugging Face a runtime. Per provare un modello nuovo bisognava scrivere la voce a mano, sha256 compresi.

## Cosa fa adesso

1. **Cerca.** Sopra l'elenco della pagina c'è "Cerca su Hugging Face". Si scrive un testo (una riga, fino a 100 caratteri) e si preme Cerca. Escono i 20 modelli MLX più scaricati che corrispondono, con download, like, licenza e compito.
2. **Scheda.** Un clic su un risultato legge la scheda del modello: commit, peso, RAM stimata, licenza, file che entrano nel catalogo (con lo sha256 dei pesi dato dall'API) e file esclusi con il motivo. Se il modello non si può aggiungere, la scheda dice perché.
3. **Aggiungi al catalogo.** Con una conferma che dice cosa si scrive e cosa esce. Il modello va in `config/models.user-catalog.yaml` come `experimental` e senza ruoli. Nessun peso si scarica in questo momento.
4. **Scarica.** Dalla scheda del modello nell'elenco, come per ogni altro modello (D-137): ripresa dai `.part`, sha256 controllato.
5. **Promuovi.** Dalla scheda del modello si scelgono i ruoli che può avere. Solo allora compare nei menu dei ruoli; l'assegnazione resta una scelta da salvare. Resta sperimentale finché non passa le prove.
6. **Togli dal catalogo.** Scrivendo l'id, quando non ha ruoli, nessuna azione in corso e nessun file sul disco.

## Privacy

- **Cosa esce:** solo il testo scritto nel campo di ricerca, oppure l'id `proprietario/nome` di un repository scelto dall'utente (con il commit, quando lo si aggiunge). Ogni uscita passa dal gateway come frammento L0 verso la destinazione `web` e lascia una riga in `gateway_log` prima della richiesta: byte e sha256, mai il testo. Lo scanner del gateway ferma un testo che sembra un IBAN, un codice fiscale o una chiave: in quel caso non parte nessuna richiesta.
- **Dove esce:** solo `https://huggingface.co`, API pubblica in sola lettura. I redirect dell'API restano su quel dominio; i file piccoli letti quando si aggiunge un modello non ripassano dal gateway (portano solo repository e commit appena passati e i percorsi della risposta di Hugging Face, come gli scaricamenti dei pesi di D-137) e possono seguire un redirect HTTPS verso un altro dominio, perché il loro contenuto si controlla contro il commit. Ogni richiesta ha un tempo massimo (60 secondi).
- **Cosa non esce:** nessun token, login, cookie, intestazione `user-agent` o altra intestazione che dica chi è l'utente o da che macchina arriva; nessun dato di conversazioni, archivio o configurazione.
- **Cosa entra:** numeri e nomi pubblici (L0). La pagina non mostra il README né la descrizione del modello: testo libero di terzi.
- **Cosa non si esegue:** i file di codice del repository (`.py` e simili) e i pesi in formato pickle (`.bin`, `.pt`, `.ckpt`…) restano fuori dal catalogo; servono pesi `.safetensors`.

## Regole per aggiungere un modello

| Regola | Perché |
| --- | --- |
| Solo modelli MLX (`library_name: mlx` o tag `mlx`) | È il formato di oMLX, il server locale (`runtime: mlx`) |
| Non privato, non ad accesso controllato (`gated`), non disattivato | Servirebbe un login: Arianna non usa account di terzi |
| Almeno un file `.safetensors` | Pesi senza codice al caricamento |
| Ogni peso ha lo sha256 nell'API (Git LFS); ogni file piccolo il suo id git | Ogni file del catalogo si verifica |
| File piccoli fuori da LFS al massimo 64 MB in tutto; al massimo 200 file; al massimo 512 GB | Limiti larghi contro risposte anomale |
| Nessun file che differisce da un altro solo per maiuscole | Sul disco del Mac sarebbero lo stesso file |
| Esclusi: pickle, codice, formati di altri runtime (`.gguf`, `.onnx`…), README, immagini, file nascosti | Non servono a oMLX o sono rischiosi |
| Commit fisso (40 cifre esadecimali) | Il catalogo non cambia se il repository cambia |

**Sha256.** Per i pesi viene dall'API (`lfs.sha256` della risposta con `blobs=true`). I file piccoli (configurazione, tokenizer) nell'API hanno solo l'id git (`blobId`, sha1 di git): quando si aggiunge il modello si leggono una volta, si controlla che l'sha1 di git sia quello del commit e si calcola lo sha256 da scrivere nel catalogo.

**Id.** Il nome del repository in minuscolo (`mlx-community/Qwen3-4B-4bit` → `qwen3-4b-4bit`); se è già preso, con il proprietario davanti, poi con un numero. È anche la cartella in `data/models` e il nome che oMLX serve.

**RAM minima.** Il catalogo la vuole: è una stima, peso dei file × 1,2, arrotondata in su; la nota della voce lo dice.

## Il catalogo dell'utente

`config/models.user-catalog.yaml`, fuori da git come `config/arianna.toml`, scritto solo dal core (file temporaneo e rename, riletto con le stesse regole prima di sostituire quello vecchio). Stesso formato del catalogo curato, con tre regole in più:

- `roles` può essere vuoto: è lo stato "aggiunto, non promosso";
- `source` è la pagina del repository su `huggingface.co`;
- ogni file è `https://huggingface.co/<repo>/resolve/<commit>/<percorso>`, tutti dello stesso commit e dello stesso repository della pagina. Un indirizzo diverso, anche scritto a mano, fa rifiutare il file.

`loadCatalog` legge prima il catalogo curato, poi quello dell'utente. Un id presente in entrambi resta quello curato: un aggiornamento del repository che aggiunge lo stesso modello non ferma il core. Il watcher della configurazione rilegge anche questo file. Un file rotto è un errore, mostrato nella pagina con il suo nome; come il catalogo curato, ferma anche l'avvio del core, il doctor e `pnpm arianna:models` finché non si corregge. Se il catalogo curato prende più avanti lo stesso id di un modello aggiunto, i file già scaricati per quel modello si confrontano con la voce curata e «Verifica» li dà sbagliati (caso raro: l'id viene dal nome del repository).

Perché in `config/` e non in `data/`: è configurazione dell'installazione, come `arianna.toml`, non dati prodotti. Viaggia con la configurazione; i pesi si riscaricano come per il catalogo curato.

## Promozione e ruoli

Un modello aggiunto ha `roles: []`: `parseRoles` rifiuta di assegnarlo a un ruolo, e la pagina non lo mostra nei menu. "Promuovi" scrive i ruoli scelti dall'utente (la scheda propone quelli del compito del modello: `text-generation` → orchestratore, estrattore, voce; `feature-extraction` → embedder; `automatic-speech-recognition` → trascrizione; `text-to-speech` → sintesi). Lo stato resta `experimental`: diventa `verified` solo con le prove (`pnpm eval`, `pnpm eval:models`), come per il catalogo curato. Un ruolo che `[roles]` dà al modello adesso non si può togliere con una nuova promozione.

## Interfaccia

- Rotte: `POST /api/models/huggingface/search` `{query}`, `POST /api/models/huggingface/card` `{repo}`, `POST /api/models/huggingface/add` `{repo, revision}`, `POST /api/models/:id/promote` `{roles}`, `POST /api/models/:id/forget` `{confirm}`. La ricerca è in POST perché il testo non finisca in un indirizzo.
- Codice: `apps/core/src/huggingface.ts` (regole, gateway, catalogo), `apps/core/src/hub-http.ts` (HTTP), `packages/config/src/catalog.ts` (catalogo dell'utente), `apps/hud/src/components/HuggingFaceSearch.vue` e `HubEntryPanel.vue`, `apps/hud/src/lib/huggingface.ts`.
- Eventi L0: `model.catalog.added` (id e repository), `model.catalog.promoted` (id e ruoli), `model.catalog.removed`.
- Campo di ricerca senza bordo colorato al focus e nessuno stile di barre proprio, come vogliono le regole della chat.

## Tappe

| Tappa | Cosa | Stato |
| --- | --- | --- |
| H1 | Catalogo dell'utente in `@arianna/config`: lettura, regole, unione con il curato, scrittura atomica, watcher | fatta (2026-10-07) |
| H2 | Core: ricerca e scheda dal gateway, aggiunta con sha256, promozione, togli dal catalogo, rotte, eventi | fatta (2026-10-07) |
| H3 | Pagina: pannello di ricerca con scheda e conferma, parte "Aggiunto da Hugging Face" nella scheda del modello | fatta (2026-10-07) |
| H4 | Prova vera con huggingface.co e un modello piccolo (scaricamento compreso) | da fare con l'utente |
| H5 | (eventuale) GGUF per un runtime `llama.cpp`; contesto letto dalla configurazione del modello | non decisa |

## Limiti noti

- La forma delle risposte dell'API è presa dalla libreria ufficiale `huggingface_hub` (campi `siblings`, `lfs.sha256`, `blobId`, `gated`): in sviluppo la rete verso huggingface.co non era aperta, quindi la prima ricerca vera è la prova dell'utente (H4).
- La ricerca usa il filtro `mlx` di Hugging Face: un modello MLX senza quel tag non compare.
- La RAM minima è una stima; contesto e punti di forza restano vuoti (non si leggono testi di terzi).
- Un modello aggiunto che poi sparisce da Hugging Face resta nel catalogo, ma non si può più scaricare.
- Le regole di aggiunta (esclusioni, stato `experimental`) valgono per ciò che scrive il core: una modifica a mano del file è controllata solo su indirizzi, commit e percorsi.

## Domande aperte

Le scelte qui sopra sono le opzioni consigliate; la conferma è la domanda `oq-modelli-da-hugging-face-scelte-di-d-139` di `docs/OPEN-QUESTIONS.md`.
