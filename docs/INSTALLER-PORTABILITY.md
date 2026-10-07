# Installer e portabilità

Obiettivo: tutto ciò che serve ad Arianna sta in una cartella (`ARIANNA_HOME`), si installa con un comando e si può spostare o replicare su un altro Mac o server, anche passando da Synology Drive.

## Layout della cartella

```
arianna/                  # repository (codice, docs, agents/, evals/)
  data/                   # NON in git
    models/               # pesi dei modelli locali (grandi)
    postgres/             # volume Docker (mai sincronizzare dal vivo)
    qdrant/               # volume Docker
    archive/              # documenti originali (L2)
    kb/                   # knowledge base markdown
    vault/                # segreti cifrati (sops + age)
    worktrees/            # worktree git dei run degli esecutori cloud
    backups/              # dump cifrati
  config/
    models.catalog.yaml   # catalogo curato: id, famiglia, runtime, RAM, ruoli, stato, file con URL e sha256
    cloud-models.catalog.yaml  # schede dei modelli cloud (I-3), scritte a mano con fonte e data di lettura
    arianna.example.toml  # configurazione di esempio, in git: i valori di sviluppo
    arianna.toml          # configurazione di questa installazione, FUORI da git, scritta da arianna init; nessun segreto
    labels.toml           # regole di etichetta per cartella e sorgente
  scripts/                # installer e utilità
```

Regola: nessun percorso assoluto nel codice; tutto è relativo a `ARIANNA_HOME`, impostabile da variabile d'ambiente. Senza la variabile, `ARIANNA_HOME` è la cartella del repository da cui gira il codice.

La configurazione si legge solo tramite `packages/config`, che rifiuta percorsi assoluti, percorsi che escono da `ARIANNA_HOME` e chiavi sconosciute. Per ora `paths.data` deve essere `data`, perché `.gitignore` esclude solo quella cartella: un altro nome farebbe entrare dati privati in git. Il limite resta finché l'installer non sa scrivere `.gitignore` per un'altra cartella (rinviato dalla prima parte del 1.17, D-047). Il controllo sui percorsi è sul testo: un collegamento simbolico dentro `data/` che punta fuori dalla cartella è ammesso (serve per i pesi dei modelli) e lo segnalerà `arianna doctor`. Un test (`test/portability.test.ts`) fa fallire `pnpm check` se nel codice o nella configurazione compare un percorso legato a una macchina.

Schema del catalogo (`version: 1`, D-048, sostituisce il manifest del 1.17): ogni modello ha `id` (minuscole, cifre, punto, trattino, trattino basso: è anche la cartella `data/models/<id>/` e quindi il nome che oMLX serve), `family`, `runtime` (`mlx`, `llama.cpp`, `vllm`), `ram_min_gib`, `roles` (uno o più fra `orchestrator`, `extractor`, `embedder`, `voice`, `stt`, `tts`: gli ultimi due ascoltano e parlano nelle chiamate, D-066), `status` (`verified` o `experimental`) e un elenco `files`, perché un modello MLX è fatto di più file. Ogni file ha `path` (relativo, dentro `data/models/<id>/`), `url` (solo https), `size_bytes` e `sha256`. Si scaricano solo i modelli assegnati a un ruolo in `[roles]` di `arianna.toml`; `pnpm arianna:models pull --trial` scarica anche tutti i candidati `stt` e `tts`, per la pagina di provino della voce (D-066). Per la pagina "Modelli" (I-3) una voce può avere anche campi facoltativi scritti a mano: `provider`, `context_tokens`, `strengths` (1-4 righe brevi), `license`, `notes`, `source` (pagina del modello, solo https); un valore che non si può verificare resta assente. Le schede dei modelli cloud stanno in `config/cloud-models.catalog.yaml` (`version: 1`): un elenco `sources` (`id`, `url` https, `read` come `AAAA-MM-GG`) e una voce per alias del router (`sonnet`, `opus`, `fable`, `codex`) con `provider`, `family`, `executor` (fissato dall'alias), `names` (nomi esatti per `--model`, della famiglia dell'alias, con contesto e uscita massimi se la fonte li dice), `strengths`, `api_price`, `quota_ratio`, `terms`, `notes`; ogni dato nomina la sua fonte, e una fonte non usata è rifiutata. Nessuno dei due si scarica a runtime. I modelli aggiunti dalla pagina Modelli cercandoli su Hugging Face (I-10, D-139) stanno in `config/models.user-catalog.yaml`, fuori da git e scritto dal core: stesso schema, `roles` vuoto finché l'utente non promuove il modello, ogni file da `https://huggingface.co/<repo>/resolve/<commit>/<percorso>`; `loadCatalog` lo unisce dopo il catalogo curato (un id presente in entrambi resta quello curato), quindi anche `pnpm arianna:models` e il doctor vedono i suoi modelli.

**La voce (D-066).** Con `[voice]` in `arianna.toml` l'installer controlla `uv` (`brew install uv`) e costruisce con `pnpm voice:sync` l'ambiente Python di `apps/voice` dentro `data/voice/`: `venv/` (l'ambiente), `python/` (l'interprete che uv scarica, mai quello della macchina), `cache/` (i pacchetti scaricati) e `tmp/` (file temporanei, cache delle librerie e `voice.log`). Le versioni sono quelle di `apps/voice/uv.lock`. Il venv contiene link simbolici assoluti: dopo uno spostamento di `ARIANNA_HOME` va rifatto con `pnpm voice:sync`, e il doctor lo segnala (`voice.env`). Su un'altra macchina l'ambiente si rifà, non si copia. Fa eccezione `data/voice/voices/` (D-069): le voci copiate da un campione (campione, testo e consenso), dati L2 dell'utente che non si possono rifare; vanno copiate con gli altri dati, come il database, e solo su macchine dell'utente.

**`arianna.toml` fuori da git (D-048).** La cartella di installazione è un clone aggiornato con `git pull`: un file di configurazione tracciato e modificato in locale andrebbe in conflitto a ogni aggiornamento, e valori come l'id della chat Telegram finirebbero in git. Nel repository c'è `config/arianna.example.toml`, generato dal codice con i valori di sviluppo (un test lo tiene identico); `config/arianna.toml` è in `.gitignore` e lo scrive `pnpm arianna:init`. Senza il file, il core, `db:up` e il doctor si fermano e dicono di lanciare il wizard; `pnpm check` non ne ha bisogno.

## Installer (`arianna install`)

1. Verifica prerequisiti: Node, pnpm, Docker, spazio libero, RAM, architettura.
2. Crea la struttura `data/` e `config/` se mancano.
3. Legge il catalogo e scarica solo i modelli mancanti fra quelli assegnati a un ruolo in `data/models/`, con ripresa, verifica sha256 e barra di avanzamento.
4. Configura il runtime locale (oMLX) perché punti a `data/models/`; se il runtime non lo consente, crea collegamenti simbolici. **Da verificare** nelle opzioni di oMLX.
5. Avvia Postgres e Qdrant con Docker Compose usando volumi dentro `data/`.
6. Applica le migrazioni e lancia `arianna doctor`: controlli di salute, modelli presenti, gateway attivo, catena di hash del registro eventi, test di contratto degli esecutori.
7. Non tocca mai le credenziali di Claude Code e Codex: il login resta manuale e a carico dell'utente.

Comandi collegati: `arianna doctor` (diagnosi), `arianna models pull|list|verify`, `arianna export`, `arianna import`.

Se `config/arianna.toml` manca, `install` parte dal wizard: i modelli da scaricare dipendono dalle risposte.

**Stato (task 1.17, prima parte, D-047; catalogo al posto del manifest con il 1.18, D-048).** Esistono `pnpm arianna:install`, `pnpm arianna:doctor` e `pnpm arianna:models list|verify|pull` (`apps/installer`). Fatti i passi 1 (spazio libero per i download; la RAM dei modelli assegnati la controllano il wizard e il doctor, `models.ram`, dal 1.18), 2 (solo `data/`, perché `config/` è nel repository; `data/` e `data/vault` private, anche se esistevano già), 3, 5 (solo Postgres: Qdrant arriva con la Fase 2) e in parte 6 (prerequisiti, cartelle, modelli presenti, password, ruolo del database, migrazioni, catena degli eventi; gateway attivo e test di contratto degli esecutori arrivano con 1.10 e 1.5). Mancano il passo 4 (oMLX non è ancora installato; il wizard propone già un server oMLX con `--model-dir data/models`, così non servono collegamenti) e le voci vere del catalogo, da copiare dalla configurazione oMLX: fino ad allora il catalogo è vuoto e `install` non scarica nulla. Il download accetta solo HTTPS, segue al massimo 5 redirect, scrive `<file>.part`, riprende con `Range` e rinomina solo dopo dimensione e sha256 giusti; un file con lo sha256 sbagliato si scarta. `doctor` controlla le dimensioni (secondi), `models verify` gli sha256 (minuti per decine di GB); `models pull --verify` sostituisce anche un file della dimensione giusta con lo sha256 sbagliato. Una risposta 206 che parte dal byte sbagliato fa ripartire da zero; un 416 (file cambiato sul server) cancella il `.part`; il `.part` va su disco con `fsync` prima della rinomina. Non ancora gestiti: due `pull` contemporanei sullo stesso file (lo sha256 scarta il risultato), conflitti fra percorsi dello stesso modello nel catalogo (`a` e `a/b`; lo stesso percorso due volte ora è rifiutato), spazio misurato sul disco di `data/models` anche quando un modello è un collegamento verso un altro disco.

## Wizard iniziale e impostazioni

**Wizard (`pnpm arianna:init`, prima di `install`, che lo lancia da solo se manca la configurazione).** Procedura guidata a domande, in italiano, che scrive `config/arianna.toml`:

1. Cartella dei dati e spazio libero (solo informativo: `paths.data` per ora è sempre `data`).
2. Scelta dei modelli locali dal catalogo per orchestratore (`local-large`) ed estrattore (`local-small`), con avviso se insieme non stanno nella RAM della macchina o nello spazio libero; se non c'è un server locale propone oMLX su `127.0.0.1:8001` con i modelli in `data/models`. Embedder e voce arrivano con le fasi successive.
3. Esecutori cloud: abilita o no Claude Code e Codex (`[cloud] executors`); dice se il binario è nel PATH (cercato, non eseguito) e mostra le istruzioni di login manuale (il wizard non tocca le credenziali).
4. Autonomia: solo informativo (D-048). Tutti partono da A1; un agente sale solo per decisione dell'utente, per agente, registrata (`AGENT-CARDS.md`); i tetti stanno nelle schede degli agenti.
5. Sincronizzazione (es. Synology): solo avvisi su ciò che va e non va sincronizzato.
6. Canali: chat web sempre attiva. Telegram è spento (D-110, domanda 12): il wizard non lo chiede e il core ignora `[telegram]`; il codice del passo resta (con `telegram: true` nel contesto chiede gli id delle chat e scrive il token come riferimento al vault, `vault://telegram-bot-token`, da inserire con `pnpm vault:edit`; canale esterno: al massimo L1, D-016). Voce e telefono rimandati alle fasi successive.
7. Riepilogo e conferma; poi il prossimo passo è `pnpm arianna:install` (modelli, database, doctor).

Il wizard è rilanciabile (`pnpm arianna:init --reconfigure`): parte dai valori attuali, conserva ciò che non chiede (database, server, password, endpoint aggiuntivi) e non scrive nulla senza conferma; riscrive però tutto il file, quindi i commenti aggiunti a mano si perdono. Un file non valido va corretto a mano prima di `--reconfigure`, che altrimenti si ferma con l'errore e la chiave. `pnpm arianna:init --defaults` scrive i valori di sviluppo senza domande, solo se il file manca. Il file si scrive accanto e si rinomina, dopo averlo validato come lo legge il core.

**Stato (task 1.18, D-048).** Fatti: catalogo, ruoli, `[cloud] executors`, wizard, `arianna.toml` fuori da git e ricarica senza riavvio. Il core controlla `arianna.toml` e il catalogo ogni secondo e applica subito ogni sezione (D-071, parte 3): ruoli e nomi dei modelli dei server locali, i server locali stessi (un cambio di `url` o `command` riavvia quel server), esecutori cloud (letti a ogni lancio: una delega già partita finisce), modelli cloud di `[cloud.models]` (alias accesi o spenti, nome esatto per `--model`, modello predefinito delle conversazioni di lavoro nuove), progetti approvati (D-058), Telegram (il bot si apre o si chiude), `[voice]` (limiti, uscite e voce alla chiamata successiva; porta, sezione accesa o spenta e `[voice.push]` riavviano solo `apps/voice` o ricreano il pusher appena non c'è una chiamata in corso) e personaggi. Restano al riavvio, scritti nel log, solo `paths`, `database` e `server`. Esecutori cloud, progetti e Telegram sono uscite: il loro cambio va nel registro eventi (`settings.executors`, `settings.projects`, `settings.telegram` senza gli id delle chat) e con il file invalido si chiudono tutte finché non torna valido (un editor che salva il file a metà può quindi chiuderle e riaprirle un attimo dopo). Chi usa la configurazione la legge a ogni uso (`settings.current()`). Con D-071 (parte 1) il core avvia e sorveglia i server locali che hanno `command` (`apps/core/src/local-servers.ts`, log in `data/<id>.log`), e il modello locale prova per ultimi quelli giù. Ogni scrittura dalla pagina Impostazioni va nel registro eventi (`settings.changed`: sezioni, privacy, id di conferma; D-071 parte 4); una modifica a mano delle sezioni che non sono uscite non lascia evento (le uscite sì: `settings.executors`, `settings.projects`, `settings.telegram`). Non ancora fatto: voci vere del catalogo (dopo oMLX).

**Progetti (D-058).** Il passo "Progetti" del wizard approva le cartelle in cui lavora il Coder (`[[project]]`: nome, percorso, etichetta L0 o L1). Il percorso di un progetto fuori da Arianna si scrive `~/...`, relativo alla home dell'utente, così il file vale anche su un altro Mac con un altro nome utente; un progetto dentro Arianna è `repos/<nome>`. Il wizard rifiuta una cartella che manca, passa da un link o non è la radice di un repository git, e dopo la scrittura crea il link `repos/<nome>` verso ogni progetto sotto la home (toglie quello di un progetto tolto; tocca solo link, mai cartelle vere). `pnpm arianna:doctor` controlla cartelle e link senza correggerli. Su una macchina nuova i progetti si ritrovano se le cartelle stanno nello stesso posto sotto la home; altrimenti il doctor le segnala e si correggono con `--reconfigure`. La lista si applica senza riavvio del core.

**Impostazioni.** Ogni valore del wizard è modificabile dopo, in due modi equivalenti: file `arianna.toml` e pagina Impostazioni nella chat/HUD. Le modifiche sono validate (schema), applicate senza riavvio quando possibile e registrate nel registro eventi. Le impostazioni che toccano la privacy (livelli, regole di etichetta, gateway, allowlist dei repository, abilitazione degli esecutori cloud e dei canali esterni) richiedono una conferma esplicita e non si cambiano da un agente. **D-071 (2026-10-04, da costruire):** la pagina applica tutto subito, privacy compresa (al riavvio restano solo `paths`, `database` e `server`, che la pagina non mostra) e, quando sarà costruita, la regola "privacy al riavvio" del paragrafo "Stato" non varrà più; la privacy si cambia con una scheda di conferma legata alla differenza esatta; le regole di etichetta e il gateway restano solo nel file; il core avvia e sorveglia oMLX; i modelli cloud si accendono, si spengono e si fissano a una versione in `[cloud.models]`.

**Catalogo modelli curato (`config/models.catalog.yaml`).** Una lista corta scelta da te, non un elenco infinito. Ogni voce ha: id, famiglia, runtime, RAM minima, ruoli adatti (`orchestrator`, `extractor`, `embedder`, `voice`, `stt`, `tts`), file con URL, dimensione e sha256, stato (`verified` se ha superato gli eval, `experimental` altrimenti). Dovrà contenere **solo il Qwen che hai già provato**; versione e quantizzazione esatte vanno copiate dalla tua configurazione oMLX: oggi è vuoto. Per aggiungere un modello: si inserisce la voce, si lancia `pnpm eval` sui gruppi router ed estrazione, e solo dopo passa a `verified`. Nelle impostazioni si assegna un modello a ogni ruolo scegliendo fra quelli del catalogo.

## Modelli: catalogo, non copia

I pesi sono decine di GB. Strategia: nel repository e nella cartella sincronizzata viaggia il **catalogo**, i pesi si scaricano di nuovo dove servono. Sul Mac si usano modelli MLX; su un server Linux serviranno formati e runtime diversi (llama.cpp o vLLM), quindi il catalogo ha una voce per runtime e lo stesso ruolo (es. `orchestrator`, `extractor`, `embedder`).

Prime voci: i modelli Qwen che usi già; nomi e versioni esatte da copiare dalla tua configurazione oMLX. Fino ad allora il modello locale si configura a mano in `arianna.toml` (`[[local.endpoints]]` con `models`).

## Due cartelle: sviluppo e installazione (D-030)

Il codice viaggia con git, i dati con Synology Drive, e le due cose non si mescolano.

| Cartella | Cosa contiene | Chi ci lavora | Come si sincronizza |
| --- | --- | --- | --- |
| Sviluppo (per esempio `~/Sites/arianna-ai`, su ogni macchina) | Codice e soli dati finti; `data/` con database e report di prova | Claude Code e Codex per costruire Arianna | Solo git. Mai sotto Synology Drive, iCloud o simili |
| Installazione (`ARIANNA_HOME` sul server, per esempio `~/Arianna` sul Mac Studio) | Lo stesso codice, aggiornato con `git pull` di `main`, più `data/` con i dati veri | Arianna. Claude Code non si avvia mai qui per sviluppare | Codice con git; `data/` con Synology Drive secondo la tabella sotto |

Il motivo è la privacy: `data/` sta dentro la cartella del progetto, quindi una sessione di sviluppo aperta nella cartella dei dati veri potrebbe leggere archivio e knowledge base, cioè dati L2 verso un esecutore cloud senza passare dal gateway. L'hook di sviluppo blocca ciò che sta fuori dal repository, non ciò che sta dentro. La cartella di installazione nasce alla fine della Fase 1A, quando entrano i dati veri; fino ad allora esiste solo quella di sviluppo.

In Synology Drive l'attività di sincronizzazione punta a `data/` della cartella di installazione, non alla radice, con le sole sottocartelle ammesse dalla tabella selezionate. Il portatile non riceve i dati veri: si collega al server via VPN.

## Sincronizzazione con Synology Drive

| Cosa | Sincronizzare? | Note |
| --- | --- | --- |
| Codice, docs, `config/`, `agents/` | Sì (meglio via git) | Con Drive, escludi `node_modules` e build |
| `data/kb/`, `data/archive/` | Sì | Contenuti L2: solo verso il tuo NAS, mai verso cloud di terzi senza cifratura |
| `data/models/` | No | Si riscaricano dal catalogo; escludere per risparmiare spazio e banda |
| `data/omlx-cache/` | No | Cache del prefisso di oMLX (D-075), fino a 10 GB: si rigenera e contiene stato derivato dai prompt, quindi L2; mai sincronizzarla |
| `data/postgres/`, `data/qdrant/` | **Mai dal vivo** | Rischio di corruzione; si sincronizzano i dump in `backups/` |
| `data/vault/` | Sì, cifrato | La chiave `age` resta fuori dalla cartella sincronizzata |
| `.git` | Con cautela | Conflitti di sincronizzazione; preferire un remote git e non sincronizzare `.git` |

Per privacy: Synology Drive sul tuo NAS è locale e va bene per L2; iCloud, Google Drive o altri cloud di terzi ricevono L2, quindi o cifratura prima della sincronizzazione o esclusione di `archive/` e `kb/`.

## Export e import

- `arianna export`: dump di Postgres, snapshot Qdrant, archivio, KB, configurazione e vault cifrato in `backups/arianna-AAAA-MM-GG.tar.age`. I modelli non sono inclusi, ma il catalogo e `arianna.toml` sì.
- `arianna import <file>`: ripristina su una macchina nuova dopo `arianna install`.
- Il ripristino va provato davvero (criterio di uscita della Fase 2).

## Stime

| Id | Task | Fase | Ore |
| --- | --- | --- | --- |
| 0.7 | Layout portabile, `ARIANNA_HOME`, `arianna.toml`, schema del manifest | 0 | 2-3 |
| 1.17 | Installer: prerequisiti, download modelli con verifica, `doctor`, collegamento a oMLX | 1B | 8-12 |
| 1.18 | Wizard `init`, schema di `arianna.toml`, catalogo modelli curato con assegnazione ai ruoli | 1B | 6-9 |
| 2.8 | `export` / `import` cifrati e prova di ripristino su altra cartella | 2 | 4-6 |
| 3.5 | Pagina Impostazioni nell'HUD (stessi valori del file, con validazione e conferma per le voci di privacy) | 3 | 8-14 |

Totale aggiunto: 28-44 ore, già incluse nei totali (stime mie, non misurate).

## Rischi

- Dimensioni dei pesi e banda di download: gli installer vanno ripresi dopo interruzioni.
- Differenze Mac/Linux nei runtime dei modelli: le prestazioni cambiano, il catalogo con una voce per runtime attenua il problema.
- Sincronizzazione che copia database aperti o che porta L2 su cloud di terzi: regole nella tabella sopra e controllo in `doctor`.
