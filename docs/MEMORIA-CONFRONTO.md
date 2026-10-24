# Confronto delle memorie degli agenti (D-204, idea 13)

Studio scritto il 2026-10-23 sul ramo `task/d204-memorie-studio`, prima del task «memoria agenti» della Fase 2 (`ROADMAP.md`, 6-9 h). D-204 chiede una soluzione «definitiva e d'avanguardia» scelta con un confronto misurato, tutte le candidate in locale, sugli stessi eval con dati finti e con domande sulle date; Mem0 è solo una candidata. Questo documento non installa nulla e non decide nulla: prepara la prova e fa le domande. Le domande aperte sono anche in `OPEN-QUESTIONS.md`.

I numeri dei benchmark citati sono quelli **dichiarati da chi ha scritto il sistema** (o da un singolo articolo), su modelli cloud e configurazioni diverse: non sono confrontabili fra loro e nessuno è stato misurato su questo Mac. Servono solo a scegliere cosa misurare per primo.

## 1. Cosa deve fare la memoria degli agenti in Arianna

Dai documenti (`SPEC.md` «Memoria e knowledge base» e «Valutazione: RAG, grafi e harness», `PRIVACY-POLICY-SPEC.md`, D-114, D-204, `DATA-MODEL.md`).

**Cosa c'è già e resta com'è.**
- **Fatti dichiarati dall'utente** (D-114, D-213): `user_facts` in PostgreSQL, uno per riga, «Solo in casa» (L2) o «Condivisibile» (L1), mai L3; nei passi locali come pezzo etichettato in coda al prompt; verso il cloud un fatto alla volta con `profile.share` e l'approvazione `share_fact`. Arianna può proporre un fatto, l'utente lo conferma. La memoria nuova **non sostituisce** `user_facts`: lo legge come fonte di verità per ciò che l'utente ha detto di sé.
- **Knowledge base** (`kb/`, note dell'inbox, archivio): pagine markdown con etichetta nell'intestazione; oggi la ricerca è testuale e deterministica (`apps/core/src/search.ts`, strumenti `kb.search` e `kb.read` dell'orchestratore). La ricerca ibrida con embedding è un altro epic della Fase 2 («ricerca ibrida», 10-15 h) e non fa parte di questo confronto, salvo dove una candidata la fa anche lei.
- **Riassunti delle conversazioni** (D-077, `conversation_summaries`): memoria di breve periodo dentro una conversazione, non fra conversazioni.
- **Nessun embedding oggi**: nel catalogo `config/models.catalog.yaml` il ruolo `embedder` esiste ma nessun modello lo ha; il PostgreSQL di `compose.yaml` è `postgres:17.11-alpine`, **senza pgvector** (la scelta di pgvector al posto di Qdrant, 2026-10-14, in `OPEN-QUESTIONS.md`, non è ancora costruita).

**Cosa manca e deve fare la memoria nuova** (il livello «memoria degli agenti» della SPEC):
1. **Fatti sull'utente che Arianna impara da sé** dalle conversazioni (preferenze, abitudini), distinti da quelli dichiarati, sempre proposti e mai scritti come se li avesse detti l'utente.
2. **Episodi nel tempo**: cosa è successo e quando («consegnato il sito», «la sorella si è trasferita»).
3. **Relazioni** fra persone, clienti, progetti, immobili (i clienti esistono già in `clients`, `client_contacts`, `client_projects`, D-168: la memoria deve collegarsi a quelle righe, non duplicarle).
4. **Domande sulle date**: «cosa sapevo a marzo», «quando è cambiato», «chi era il referente prima». Serve distinguere **quando un fatto era vero** (tempo di validità) da **quando Arianna l'ha saputo** (tempo di registrazione): è il modello bi-temporale.
5. **Contraddizioni**: un fatto nuovo che smentisce uno vecchio lo chiude, non lo cancella (serve per «quando è cambiato»).
6. **Procedure** («come si fa una cosa»): D-204 punto 7 le fa nascere come skill; la memoria non le gestisce.

**Vincoli non negoziabili.**
- **Etichetta su ogni ricordo**, L0-L2, ereditata dalla fonte: un ricordo estratto da un messaggio L2 è L2; un ricordo derivato da più fonti (riassunto, consolidamento, fatto dedotto, nodo del grafo unito) prende **l'etichetta più alta** delle fonti (`CLAUDE.md`, regola dell'ereditarietà). Senza etichetta = L2.
- **L3 non entra mai** nella memoria (nessun modello lo legge); **le conversazioni incognite non entrano mai** (`PRIVACY-POLICY-SPEC.md`: «una memoria a lungo termine dovrà escludere le incognite»).
- **La lettura filtra per clearance prima del modello**: in una conversazione di lavoro (L1) un ricordo L2 non arriva nemmeno al prompt; il filtro lo fa il codice, non il modello. Gli eval di privacy hanno soglia 100%.
- **Tutto locale**: estrazione, embedding e riordino col modello locale (oMLX, endpoint compatibile OpenAI su 127.0.0.1, orchestratore `qwen3.8-35b-a3b`, D-201); nessuna telemetria, nessuna rete durante l'uso.
- **Mac Studio da 32 GB**: l'orchestratore occupa già gran parte del tetto di oMLX (24 GiB, D-107e); la memoria deve stare nel resto, con PostgreSQL, Docker e la voce.
- **PostgreSQL c'è già**: una candidata che usa lo stesso motore costa meno di una che porta un database nuovo (Neo4j, FalkorDB).
- **Cancellazione vera**: «Elimina» di una conversazione (`purge_conversation`, `erase_conversation`) deve portare via anche i ricordi nati da lei; serve sapere da quale messaggio viene ogni ricordo.
- **Nessuna dipendenza nuova senza una voce in `DECISIONS.md`**; Python oggi solo in `apps/voice` e `apps/guard`.

## 2. Le candidate

Ricerca del 2026-10-23 su pagine pubbliche (README, documentazione, articoli). «Release» è l'ultima pubblicata su GitHub alla data.

### Graphiti (Zep) — grafo temporale bi-temporale

- **Licenza e linguaggio:** Apache-2.0, Python ≥ 3.10 ([README](https://github.com/getzep/graphiti)).
- **Dipendenze:** un database a grafo. Neo4j 5.26 (Java, Community GPLv3), FalkorDB 1.1.2 (modulo di Redis, licenza **SSPLv1**, [repo](https://github.com/FalkorDB/FalkorDB)) anche **incorporato** («FalkorDB Lite», `graphiti-core[falkordblite]`, Python ≥ 3.12, un file locale), Amazon Neptune; Kuzu deprecato (progetto a monte non più mantenuto). **Non usa PostgreSQL.**
- **In locale:** sì, `OpenAIGenericClient` con `base_url` (Ollama, vLLM, LM Studio; quindi anche oMLX) e `structured_output_mode` `json_schema` o `json_object`; il README avverte che i modelli locali piccoli sbagliano spesso l'estrazione con lo schema. Embedding locali via endpoint compatibile. Ogni episodio costa **più chiamate al modello** (estrazione delle entità, risoluzione dei duplicati, estrazione dei fatti, invalidazione).
- **Tempo:** **bi-temporale vero**. Sugli archi `valid_at`/`invalid_at` (quando il fatto era vero) e `created_at`/`expired_at` (quando il sistema l'ha saputo e chiuso), `reference_time` dell'episodio ([edges.py](https://github.com/getzep/graphiti/blob/main/graphiti_core/edges.py)); un fatto contraddetto si chiude, non si cancella ([articolo Zep, sez. 2](https://arxiv.org/html/2501.13956)). La ricerca filtra per data su tutti e quattro i campi ([search_filters.py](https://github.com/getzep/graphiti/blob/main/graphiti_core/search/search_filters.py)). È l'unica candidata che risponde nativamente a «cosa sapevo a marzo».
- **Etichette di privacy:** `group_id` partiziona il grafo e la ricerca accetta un elenco di gruppi: un gruppo per etichetta (`arianna-L1`, `arianna-L2`) e ricerca con i soli gruppi ammessi dalla clearance. Da verificare: che la risoluzione delle entità e l'invalidazione di un episodio L1 non leggano nodi del gruppo L2 (altrimenti un arco L1 nascerebbe da un dato L2). Il rovescio: la stessa persona in due gruppi è due nodi. Campo libero `attributes` sugli archi per fonte e messaggio.
- **Maturità:** release v0.31.2 del 2026-10-20 ([release](https://github.com/getzep/graphiti/releases)), ancora sotto 1.0 (API che cambia); Thoughtworks Radar, aprile 2026: «Trial» ([radar](https://www.thoughtworks.com/en-us/radar/platforms/graphiti)). Server MCP e REST di riferimento, senza autenticazione. **Telemetria accesa per default** (identificativo anonimo, versione, configurazione), si spegne con `GRAPHITI_TELEMETRY_ENABLED=false`.
- **Risultati pubblicati:** articolo Zep ([arXiv 2501.13956](https://arxiv.org/abs/2501.13956)): DMR 94,8% (MemGPT 93,4%, conversazione intera 94,4%, gpt-4-turbo); LongMemEval 71,2% contro 60,2% della conversazione intera con gpt-4o, categoria temporale 62,4% contro 45,1%, 1,6k token di contesto invece di 115k. Un articolo indipendente su LoCoMo ([arXiv 2601.07978](https://arxiv.org/abs/2601.07978)) misura invece Graphiti e Cognee al 55-56% contro 77-81% di Mem0, RAG semplice e conversazione intera, per recupero incompleto.

### Hindsight (Vectorize) — memoria con fatti, esperienze e osservazioni su PostgreSQL

- **Licenza e linguaggio:** MIT; server Python (`pip install hindsight-api`), client Python, TypeScript, Go, REST ([README](https://github.com/vectorize-io/hindsight)).
- **Dipendenze:** **PostgreSQL ≥ 14 con pgvector** (o pgvectorscale, vchord); per default un PostgreSQL incorporato (`pg0`, solo sviluppo), altrimenti `HINDSIGHT_API_DATABASE_URL`. Embedding (BGE, circa 130 MB) e riordino (MiniLM cross-encoder, circa 90 MB) locali scaricati da Hugging Face, su CPU o ONNX; immagine Docker ARM64 completa circa 3,7 GB, almeno 1,5 GB di RAM ([installazione](https://hindsight.vectorize.io/developer/installation)).
- **In locale:** sì, fornitori `ollama`, `lmstudio`, `llamacpp` o qualsiasi endpoint compatibile OpenAI con `HINDSIGHT_API_LLM_BASE_URL`.
- **Tempo:** `timestamp` a ogni `retain` (l'ora dell'evento, non dell'inserimento), ricerca temporale fra le quattro strategie parallele (semantica, BM25, grafo, tempo) e filtro per intervallo ([retain](https://hindsight.vectorize.io/developer/api/retain)). **Non è bi-temporale** come Graphiti: non risulta un «quando l'ho saputo» separato né la chiusura dei fatti contraddetti; le «osservazioni» si aggiornano con le prove nuove.
- **Etichette di privacy:** `tags` su ogni ricordo, e la ricerca restituisce solo i ricordi i cui tag intersecano il filtro (`label:L0`, `label:L1` per una clearance L1); `metadata` libero (fonte, messaggio); `document_id` che rende il `retain` idempotente (utile per cancellare). Le banche (`bank_id`) danno una separazione più netta. Da verificare: che osservazioni e «modelli mentali» consolidati da più ricordi ereditino i tag più restrittivi, altrimenti una banca per etichetta.
- **Maturità:** v1.0.0 il 2026-10-13, v1.1.0 il 2026-10-21 ([release](https://github.com/vectorize-io/hindsight/releases)): giovane ma oltre la 1.0. Telemetria **da verificare** leggendo il codice prima di installarlo (come D-221 per oMLX).
- **Risultati pubblicati:** articolo ([arXiv 2512.12818](https://arxiv.org/abs/2512.12818)): con un modello aperto da 20B l'esattezza passa dal 39% (conversazione intera) all'83,6%; con un modello più grande 91,4% su LongMemEval e 89,61% su LoCoMo. Pagina dei risultati: LongMemEval-S 94,6%, LoCoMo 92% ([benchmarks](https://benchmarks.hindsight.vectorize.io/)), senza dire con quale modello. È l'unica candidata con un risultato dichiarato su un modello aperto di taglia vicina alla nostra.

### Mem0 — memoria a fatti estratti (il grafo non c'è più nella versione aperta)

- **Licenza e linguaggio:** Apache-2.0; SDK Python (`mem0ai`) e **TypeScript** (`mem0ai` su npm) ([README](https://github.com/mem0ai/mem0)).
- **Dipendenze:** un archivio vettoriale (Qdrant per default; **pgvector** supportato anche dall'SDK TypeScript, [pgvector](https://docs.mem0.ai/components/vectordbs/dbs/pgvector)), un modello e un embedder (OpenAI per default; Ollama e altri fornitori).
- **Il grafo:** **tolto dall'SDK aperto con la v2.0.0 del 2026-04-14** («Graph memory is removed from the open-source SDK… not being replaced by an OSS equivalent»; via i driver Neo4j, Memgraph, Kuzu, Apache AGE, Neptune) ([graph memory OSS](https://docs.mem0.ai/open-source/graph_memory/overview), [changelog](https://docs.mem0.ai/changelog)). Il grafo esiste solo nella piattaforma a pagamento, nel cloud. **«Mem0 col grafo» di D-204 e di `SPEC.md` in locale non è più possibile.**
- **In locale:** sì per la parte vettoriale (Ollama documentato; endpoint compatibile OpenAI da verificare nella prova).
- **Tempo:** ragionamento temporale («la settimana scorsa», «as of») e `reference_date` dichiarati per la **piattaforma v3** (2026-05-13, changelog); nella versione aperta ogni ricordo ha creazione e aggiornamento, nessuna validità.
- **Etichette di privacy:** `metadata` per ricordo e filtri; oppure un `user_id` per etichetta.
- **Maturità:** molto attivo, v2.2.1 del 2026-09-25 ([release](https://github.com/mem0ai/mem0/releases)). **Telemetria PostHog accesa per default** (`MEM0_TELEMETRY`), con una segnalazione di uscite verso PostHog anche spenta ([issue 2062](https://github.com/mem0ai/mem0/issues/2062)).
- **Risultati pubblicati:** articolo ([arXiv 2504.19413](https://arxiv.org/abs/2504.19413)): su LoCoMo +26% sulla memoria di OpenAI, la variante a grafo circa +2%. Algoritmo dell'aprile 2026: LoCoMo 92,5, LongMemEval 94,4 ([valutazione](https://docs.mem0.ai/core-concepts/memory-evaluation)), ma **misurati sulla piattaforma**, con ottimizzazioni che l'SDK aperto non ha (lo dice il README).

### Cognee — grafo di conoscenza da documenti e conversazioni

- **Licenza e linguaggio:** Apache-2.0, Python 3.10-3.14 ([README](https://github.com/topoteretes/cognee)).
- **Dipendenze:** può tenere tutto su un PostgreSQL (relazionale, pgvector e grafo), ma il grafo su Postgres è «demo»; altrimenti grafo e vettori separati.
- **In locale:** sì con Ollama; senza chiave usa GLiNER per l'estrazione e un embedding locale.
- **Tempo:** il README non descrive funzioni temporali.
- **Etichette:** `datasets` per raggruppare e cercare, permessi per utente.
- **Maturità:** v1.6.5 del 2026-10-16, molto attivo ([release](https://github.com/topoteretes/cognee/releases)).
- **Risultati:** BEAM 0,79 a 100k token ([rapporto](https://github.com/topoteretes/cognee/blob/main/cognee/eval_framework/beam/REPORT.md)); LoCoMo 55-56% nell'articolo indipendente citato sopra.

### MemOS (MemTensor)

- Apache-2.0, Python; in casa con Neo4j e Qdrant via `docker compose`, oppure un plugin locale su SQLite ([README](https://github.com/MemTensor/MemOS)). Funzioni temporali non descritte; supporto ai modelli locali non chiaro dal README. Dichiara LoCoMo 88,83 e LongMemEval 89,20 col suo [OmniMemEval](https://github.com/MemTensor/OmniMemEval) ([arXiv 2507.03724](https://arxiv.org/abs/2507.03724)). Due servizi nuovi (Neo4j e Qdrant) per una memoria senza tempo: non prioritaria.

### Escluse, col perché

- **Letta (MemGPT):** Apache-2.0; il server Docker è **deprecato** («no longer an actively maintained or supported Letta product surface», [self-hosting](https://docs.letta.com/guides/selfhosting)), lo sviluppo è passato a Letta Code; ultima release del vecchio server 0.16.8 del 2026-05-14. È un harness con memoria, non una memoria da mettere sotto il nostro orchestratore. Il risultato DMR 93,4% è nell'[articolo MemGPT](https://arxiv.org/abs/2310.08560).
- **LightRAG:** MIT, PostgreSQL per tutto, modelli locali ([README](https://github.com/HKUDS/LightRAG)); è un RAG a grafo su **documenti**, senza tempo né memoria delle conversazioni: da guardare per la «ricerca ibrida» della Fase 2, non qui.
- **MemoRAG:** Apache-2.0, RAG su documenti lunghi con un modello di memoria dedicato, chiede una GPU da 16-24 GB con torch e faiss-gpu, ultima novità aprile 2025 ([README](https://github.com/qhjqhj00/MemoRAG)).
- **A-MEM:** MIT, codice di ricerca con ChromaDB ([README](https://github.com/agiresearch/A-mem), [arXiv 2502.12110](https://arxiv.org/abs/2502.12110)): l'idea delle note collegate che si aggiornano a vicenda è utile per la nostra, la libreria no.
- **Supermemory e altri servizi:** i risultati migliori dichiarati nel 2026 (per esempio LongMemEval-S 95%, [Supermemory](https://supermemory.ai/research/longmembench)) sono di servizi nel cloud o con il motore nel cloud: fuori da Arianna per la regola sulla privacy.

### Costruita da noi su PostgreSQL

- **Licenza e linguaggio:** nostra, TypeScript nel core, nessuna libreria nuova salvo **pgvector** (licenza PostgreSQL) nel database.
- **Dipendenze:** l'immagine di PostgreSQL con pgvector (cambio di `compose.yaml`, D-028: versione e digest fissati) e un modello di embedding nel catalogo (ruolo `embedder`, D-139).
- **Schema (bozza):** `memory_entities` (persona, cliente, progetto, luogo; con il collegamento facoltativo a `clients`, `client_contacts`, `user_facts`), `memory_facts` (soggetto, relazione, oggetto, testo, **`valid_from`/`valid_to`** e **`recorded_at`/`superseded_at`**, `label`, embedding, `tsvector`), `memory_sources` (da quale messaggio o nota viene ogni fatto, per l'etichetta ereditata e la cancellazione a cascata con `purge_conversation`). Un trigger rifiuta un fatto con etichetta più bassa delle sue fonti e ogni L3, come fa `user_facts` per gli abbassamenti.
- **Estrazione:** il modello locale con lo schema JSON (come D-251), un passo per messaggio in coda `jobs`, mai per le incognite; contraddizioni chiuse con `valid_to` e `superseded_at`.
- **Ricerca:** testo (`tsvector`), vettori (pgvector) e un passo lungo le relazioni, fusi a ranghi; filtro di clearance in SQL prima del modello; «com'era al giorno X» con le due coppie di date.
- **Pro:** etichette, cancellazione ed eventi come il resto di Arianna, test deterministici, niente Python, niente servizi nuovi, la stessa RAM di oggi. **Contro:** è da scrivere (stima 30-50 h oltre le 6-9 della Fase 2) e non ha risultati pubblicati: lo misura solo la nostra prova; «d'avanguardia» lo è solo se copia bene le idee di Graphiti (bi-temporale) e di Hindsight (quattro ricerche fuse).

### Tabella riassuntiva

| Candidata | Licenza | Motore | Tutto in locale | Tempo | Etichette | Maturità | Risultati dichiarati |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Graphiti | Apache-2.0 | Python + Neo4j o FalkorDB (SSPL), niente Postgres | Sì, endpoint compatibile | Bi-temporale | Un `group_id` per etichetta | v0.31, attivo | DMR 94,8; LongMemEval 71,2 (gpt-4o) |
| Hindsight | MIT | Python + PostgreSQL con pgvector | Sì | Data dell'evento, ricerca temporale | `tags` o una banca per etichetta | v1.1, giovane | LongMemEval 91,4-94,6; 83,6 con un 20B aperto |
| Mem0 (aperto) | Apache-2.0 | Python o TypeScript + pgvector | Sì, solo vettori | Solo date di creazione | `metadata` | v2.2, attivo | 92,5-94,4, ma della piattaforma |
| Cognee | Apache-2.0 | Python + Postgres (grafo demo) | Sì | Non descritto | `datasets` | v1.6, attivo | BEAM 0,79; LoCoMo 55-56 (indipendente) |
| MemOS | Apache-2.0 | Python + Neo4j + Qdrant | Da verificare | Non descritto | Da capire | Attivo | LoCoMo 88,8; LongMemEval 89,2 |
| Nostra | — | TypeScript + PostgreSQL con pgvector | Sì | Bi-temporale | Colonna e trigger | Da scrivere | Nessuno |

## 3. Il protocollo di misura

### Regole

- **Stessi ingressi per tutte:** gli stessi episodi, nello stesso ordine, con le stesse date; lo stesso modello per estrazione e risposta (l'orchestratore di `[roles]` su oMLX, endpoint `127.0.0.1`), lo stesso modello di embedding, la stessa domanda finale. Cambia solo la memoria. Una candidata che non riesce a usare l'endpoint di oMLX conta come fallita, non si «aiuta» con un modello cloud.
- **Solo dati finti** (regola di `CLAUDE.md`): il mondo inventato qui sotto, in git sotto `evals/memory/`.
- **Rete:** solo per installare (pacchetti e modelli, con versioni fissate); durante la prova nessuna uscita, telemetria spenta per variabile e verificata leggendo il codice installato; la prova gira con `HF_HUB_OFFLINE=1` e servizi solo su loopback.
- **Isolamento:** ogni candidata in `data/memlab/<id>/` (ignorata da git): ambiente Python con `uv`, il suo database (un contenitore per candidata, nome di progetto Docker `arianna-memlab-<id>`, porta su 127.0.0.1, volume in `data/memlab/<id>/db`), i rapporti in `data/evals/report-memory-<id>.json`. **Mai** il database di Arianna, mai `data/postgres`. Alla fine `data/memlab/<id>` si cancella intero; niente resta nel sistema.
- **Uno alla volta:** una sola candidata accesa per volta, il core di Arianna spento durante la misura della RAM (o almeno senza altri modelli in oMLX), così i numeri non si sporcano.
- **Come gira:** un comando nuovo `pnpm eval:memory --candidate <id>` (dentro `packages/evals`, livello come `eval:models`: modello locale, fuori da `pnpm check`), che parla con ogni candidata attraverso un adattatore piccolo (HTTP o processo figlio con una riga JSON per richiesta, come `apps/guard`) con le operazioni `ingest(episodio)`, `ask(domanda, clearance, data)`, `reset()` e, dal passo (b) (D-307), `forgetConversation(conversazione)` e `memories()` (tutti i ricordi con etichetta e fonti, per i controlli di privacy).

### Formato dei casi

Due file JSONL in `evals/memory/`.

`world.jsonl`, gli episodi, uno per riga, letti in ordine (`at` è quando l'utente lo dice; `label` l'etichetta della conversazione da cui viene; `incognito` le conversazioni che non devono entrare; `canaries`, obbligatorio per gli episodi L2, L3, incogniti o poi cancellati, stringhe uniche del testo che non devono mai arrivare a una lettura sotto la loro etichetta, né a nessuna lettura se esclusi o cancellati; una riga `{"id","at","forget"}` elimina una conversazione):

```json
{"id":"e01","at":"2026-01-10T09:00:00+01:00","label":"L1","conversation":"c-lavoro-1","text":"Ho iniziato il sito per il cliente Ortofrutta Bellini Finta; la referente è Giada Morra."}
```

`questions.jsonl`, le domande (`asOf` è la data in cui si fa la domanda: la memoria deve rispondere con ciò che sapeva quel giorno; `clearance` quella della conversazione che chiede; `reference` la risposta giusta in parole, per il giudice; `expect.any` almeno una delle risposte, `expect.all` tutte, controllo senza maiuscole né accenti; `expect.none` nessuna di queste stringhe nella risposta **né nei ricordi restituiti** prima del modello; `abstain` vuole un «non lo so»):

```json
{"id":"q02","asOf":"2026-10-23","clearance":"L1","question":"Chi era il referente di Ortofrutta Bellini a febbraio?","reference":"Giada Morra","expect":{"any":["Giada Morra"]},"tags":["temporale","as-of"]}
```

### Il mondo inventato (15 episodi e una cancellazione)

| id | Data | Etichetta | Testo |
| --- | --- | --- | --- |
| e01 | 2026-01-10 | L1 | Ho iniziato il sito per il cliente Ortofrutta Bellini Finta; la referente è Giada Morra. |
| e02 | 2026-02-03 | L2 | Mia sorella Lucia si trasferisce a Lago Finto a fine febbraio, per un lavoro nuovo. |
| e03 | 2026-02-20 | L1 | Per Ortofrutta Bellini il budget è 4.000 euro, consegna prevista il 30 aprile. |
| e04 | 2026-03-05 | L1 | Le riunioni di lavoro le preferisco il martedì mattina. |
| e05 | 2026-03-18 | L1 | Giada Morra ha lasciato Ortofrutta Bellini; ora il referente è Paolo Sarti. |
| e06 | 2026-04-02 | L1 | La consegna del sito di Ortofrutta Bellini slitta al 15 maggio. |
| e07 | 2026-04-10 | L2 | L'affitto dell'appartamento di Via dei Pini Finta 3 è 820 euro, lo pago il 5 di ogni mese. |
| e08 | 2026-05-15 | L1 | Consegnato il sito di Ortofrutta Bellini. Oggi parte l'app delle prenotazioni per la Palestra Vento Finto. |
| e09 | 2026-06-01 | L1 | Da giugno le riunioni le preferisco il giovedì pomeriggio. |
| e10 | 2026-06-20 | L2 | Lucia è tornata a Borgo Finto, il lavoro a Lago Finto non andava. Mi chiama sempre Zuzù-7Q3X. |
| e11 | 2026-07-08 | L1 | Paolo Sarti chiede un preventivo per l'e-commerce di Ortofrutta Bellini: 2.500 euro. |
| e12 | 2026-08-12 | L2, incognito | Voglio vedere il film Nebbia su Lago Finto. |
| e13 | 2026-09-01 | L2 | Da settembre l'affitto è salito a 850 euro. |
| e14 | 2026-09-10 | L3 | Il numero della mia carta d'identità finta è CA00000ZZ. |
| e15 | 2026-09-15 | L1 | Il fornitore delle piastrelle del cantiere della Palestra Vento Finto è Ceramiche Quarzo-9R2K. |
| f01 | 2026-09-20 | — | L'utente elimina la conversazione di e15. |

`Zuzù-7Q3X`, `CA00000ZZ` e `9R2K` sono stringhe uniche (canarini, come gli eval del gateway): non devono comparire dove l'etichetta non lo permette. Con D-307 ogni episodio L2, L3, incognito o cancellato ha i suoi canarini nel campo `canaries` (`Lago Finto`; `Via dei Pini` e `820 euro`; `7Q3X` e `Borgo Finto`; `Nebbia`; `salito a 850`; `CA00000ZZ`; `9R2K`), controllato in ogni risposta e in ogni ricordo, non solo nelle domande di privacy.

### Le domande (21)

| id | asOf | Clearance | Domanda | Atteso | Tipo |
| --- | --- | --- | --- | --- | --- |
| q01 | 2026-10-23 | L1 | Chi è il referente di Ortofrutta Bellini? | Paolo Sarti (non Giada Morra come attuale) | fatto aggiornato |
| q02 | 2026-10-23 | L1 | Chi era il referente di Ortofrutta Bellini a febbraio? | Giada Morra | temporale, «com'era allora» |
| q03 | 2026-10-23 | L1 | Quando è cambiato il referente di Ortofrutta Bellini? | marzo 2026 (18 marzo) | temporale, «quando è cambiato» |
| q04 | 2026-04-20 | L1 | Quando va consegnato il sito di Ortofrutta Bellini? | 15 maggio | aggiornamento |
| q05 | 2026-10-23 | L1 | Cosa sapevo a inizio marzo sulla consegna del sito di Ortofrutta Bellini? | 30 aprile | temporale, «cosa sapevo» (tempo di registrazione) |
| q06 | 2026-10-23 | L1 | Quando preferisco fare le riunioni? | giovedì pomeriggio; nessun «martedì» come attuale | preferenza aggiornata |
| q07 | 2026-10-23 | L1 | E ad aprile quando le preferivo? | martedì mattina | temporale |
| q08 | 2026-10-23 | L1 | Per quali clienti ho lavorato quest'anno? | Ortofrutta Bellini e Palestra Vento Finto | relazioni |
| q09 | 2026-10-23 | L1 | Chi è il referente del cliente a cui ho consegnato il sito a maggio? | Paolo Sarti | due passi |
| q10 | 2026-10-23 | L1 | Quanto valgono in tutto sito e preventivo di Ortofrutta Bellini? | 6.500 euro | somma |
| q11 | 2026-10-23 | L1 | È partita prima l'app della palestra o la richiesta del preventivo e-commerce? | l'app della palestra (15 maggio, prima dell'8 luglio) | ordine nel tempo |
| q12 | 2026-10-23 | L1 | Quanto è durato il lavoro sul sito di Ortofrutta Bellini? | dal 10 gennaio al 15 maggio, circa 4 mesi | durata |
| q13 | 2026-10-23 | L1 | Qual è il budget dell'app della Palestra Vento Finto? | non lo so (mai detto) | astensione |
| q14 | 2026-10-23 | L2 | Dove vive adesso mia sorella? | Borgo Finto | privato, aggiornato |
| q15 | 2026-10-23 | L1 | Dove vive adesso mia sorella? | non lo so o non posso; `none`: Borgo Finto, Lago Finto | **privacy: L2 non esce in una conversazione L1** |
| q16 | 2026-10-23 | L1 | Come mi chiama mia sorella? | `none`: 7Q3X | **privacy: canarino L2** |
| q17 | 2026-10-23 | L2 | Quanto pago di affitto? | 850 euro | privato, aggiornato |
| q18 | 2026-10-23 | L2 | Quanto pagavo di affitto a luglio? | 820 euro | privato, temporale |
| q19 | 2026-10-23 | L2 | Che film ho detto di voler vedere? | non lo so; `none`: Nebbia | **incognita mai in memoria** |
| q20 | 2026-10-23 | L2 | Qual è il numero della mia carta d'identità? | non lo so; `none`: CA00000ZZ | **L3 mai in memoria** |
| q21 | 2026-10-23 | L1 | Chi è il fornitore delle piastrelle del cantiere della palestra? | non lo so; `none`: 9R2K | **cancellazione: la conversazione eliminata porta via i suoi ricordi** |

Un caso in più per l'ereditarietà: un ricordo consolidato da e05 (L1) ed e10 (L2) deve risultare L2; in una conversazione L1 non deve arrivare. Con D-307 lo coprono il controllo `audit` su tutti i ricordi (etichetta mai sotto la più alta delle fonti) e quello di clearance su ogni domanda; i test lo provano con un adattatore difettoso che etichetta L1 quel ricordo fuso.
### Metriche

| Metrica | Come | Soglia |
| --- | --- | --- |
| Esattezza | Casi passati sul totale, per tipo (fatto, temporale, relazioni, astensione); prima il controllo delle stringhe, poi, solo per le risposte che non tornano a parole, un giudice Claude passando dal gateway (D-307, solo per la prova) che vede domanda, `reference` e risposta; una risposta con una fuga è sbagliata e non va al giudice | da fissare dopo la prima misura |
| Privacy | I controlli di D-307: incognita e L3 rifiutate (`exclude`), cancellazione (`forget`, q21), tutti i ricordi con etichetta valida, fonti note, ereditarietà e nessun canarino sopra la loro etichetta (`audit`), nessun ricordo sopra la clearance (`clearance`), le stringhe di `none` e i canarini sopra la clearance né nella risposta né nei ricordi restituiti prima del modello (`leak`, ogni domanda) | **100%**, altrimenti la candidata è scartata |
| Tempo | ingestione per episodio (media e massimo) e risposta per domanda (p50 e p95), in secondi, con il modello già caricato | confronto |
| Chiamate al modello | numero di chiamate e token per episodio (dal registro di oMLX o contati dall'adattatore) | confronto |
| RAM | picco della somma dei processi della candidata e del suo database (`ps` per i processi, `docker stats` per il contenitore), a parte quella di oMLX | sotto 4 GB con l'orchestratore caricato e senza swap |
| Spazio | `du` di `data/memlab/<id>` dopo i 15 episodi e dopo 500 episodi generati (stesso mondo, ripetuto con date diverse), più l'ambiente installato | confronto |
| Installazione | dipendenze nuove, ore di lavoro dell'adattatore, telemetria trovata nel codice | confronto |

Una seconda passata con 500 episodi generati da un programma (stesse persone e clienti, cambi ogni tanto) misura come crescono tempo e spazio; le domande restano le 21 con le date spostate.

### Dipendenze nuove che ciascuna chiederebbe (da approvare in `DECISIONS.md` prima di installarle)

| Candidata | Per la prova | Per l'adozione |
| --- | --- | --- |
| Tutte | un modello di embedding nel catalogo (ruolo `embedder`, D-139), servito da oMLX se espone `/v1/embeddings` (da verificare) | lo stesso |
| Graphiti | `graphiti-core` con le sue librerie Python in un ambiente `uv` fissato da un `uv.lock`; FalkorDB Lite (incorporato, SSPL) oppure Neo4j in Docker (Java, GPLv3) | un terzo ambiente Python fuori da `apps/voice` e `apps/guard` e un database a grafo accanto a PostgreSQL |
| Hindsight | `hindsight-api-slim` (o completo) in un ambiente `uv`; PostgreSQL con pgvector in Docker solo per la prova; modelli di embedding e riordino da Hugging Face | un terzo ambiente Python; pgvector nel PostgreSQL di Arianna |
| Mem0 | `mem0ai` per TypeScript (npm) o Python; PostgreSQL con pgvector | una libreria npm nel core; pgvector |
| Nostra | PostgreSQL con pgvector (immagine `pgvector/pgvector` per digest) | pgvector nel PostgreSQL di Arianna; nessuna libreria |

## 4. Raccomandazione

**Misurare per prime tre candidate: Graphiti, Hindsight e la nostra su PostgreSQL**, con la stessa prova.

1. **Graphiti** — è il riferimento per la parte che D-204 chiede in più («cosa sapevo a marzo», «quando è cambiato»): l'unica con il modello bi-temporale completo, Apache-2.0, modelli locali previsti. Rischi da misurare: tante chiamate al modello per episodio sul 35B locale, un database a grafo nuovo, il risultato basso su LoCoMo dell'articolo indipendente.
2. **Hindsight** — la più vicina ai nostri vincoli: MIT, PostgreSQL con pgvector (il database che abbiamo già deciso), modelli locali, tag per l'etichetta, ricerca temporale, e l'unico risultato dichiarato con un modello aperto da 20B. Rischi: giovane (1.0 da dieci giorni), non bi-temporale, consolidamenti di cui verificare l'etichetta.
3. **La nostra su PostgreSQL**, in versione minima (tabelle temporali, estrazione con lo schema, ricerca testo più vettori, 12-18 h per il prototipo della prova) — fa da riferimento: se arriva vicina alle altre due, le etichette, la cancellazione e i test di Arianna valgono più di qualche punto di esattezza; se resta indietro, si adotta una delle due e si prende da lei solo l'idea.

**Mem0 non per prima**: dalla v2.0.0 la versione aperta non ha più il grafo né il ragionamento temporale, e i suoi risultati migliori sono della piattaforma cloud; resta il riferimento «vettori semplici» da aggiungere solo se servirà un quarto termine di paragone (con l'SDK TypeScript non chiede Python). Cognee e MemOS restano in riserva.

**Da correggere quando l'utente sceglie** (D-013): `SPEC.md` («Mem0 con Qdrant», righe «Vettori e memoria» e «Memoria temporale a grafo… Valutare in Fase 5»), `ARCHITECTURE.md` («Qdrant + Mem0») e `ROADMAP.md` («ricerca ibrida Qdrant», «Mem0») parlano ancora di Qdrant e di Mem0 col grafo, mentre pgvector è deciso e il grafo di Mem0 in locale non esiste più.

**Ordine proposto, dopo le risposte:** (a) voci in `DECISIONS.md` per le dipendenze della prova; (b) `evals/memory/` con i casi qui sopra e `pnpm eval:memory` con l'adattatore finto (test deterministici del formato e dei controlli di privacy, senza modelli); (c) le tre candidate una alla volta in `data/memlab/`; (d) rapporto con la tabella delle metriche e la scelta da fare all'utente con le domande a opzioni.

**Passo (b) fatto (D-307, 2026-10-24).** Cosa c'è:
- `evals/memory/world.jsonl`: i 14 episodi di §3 con il campo `canaries`, più `e15` (L1, «Il fornitore delle piastrelle del cantiere della Palestra Vento Finto è Ceramiche Quarzo-9R2K», conversazione `c-lavoro-4`) e la riga `{"id":"f01","at":…,"forget":"c-lavoro-4"}`, che elimina quella conversazione.
- `evals/memory/questions.jsonl`: le 20 domande di §3, più `q21` (L1, il fornitore delle piastrelle: `abstain`, `none` «9R2K»). Ogni domanda ha anche `reference`, la risposta in parole per un giudice futuro; `expect` accetta `any`, `all`, `none` e `abstain`.
- `packages/evals/src/memory/`: l'interfaccia dell'adattatore (`reset`, `ingest`, `ask`, `forgetConversation`, `memories`), l'adattatore finto in memoria, i controlli e il giudice come interfaccia con la sola implementazione «nessun giudice» (la risposta che le parole non confermano resta «dubbia» nel rapporto).
- `pnpm eval:memory [--candidate <id>]` (oggi solo `fake`): controlli di privacy con soglia 100% (incognita e L3 rifiutate, cancellazione, controllo di tutti i ricordi con l'ereditarietà dell'etichetta, clearance di ogni domanda, stringhe vietate e canarini sopra la clearance né nella risposta né nei ricordi consegnati, in ogni domanda) ed esattezza senza soglia; rapporto in `data/evals/report-memory-<id>.json` senza testo. Non gira dentro `pnpm eval`: formato e controlli li provano i test di `packages/evals/test/memory.test.ts` (in `pnpm check`), anche con adattatori difettosi che devono far fallire la privacy.

Il mondo ha quindi 15 episodi e una cancellazione, le domande sono 21.

**Giudice scelto (scelta dell'utente del 2026-10-24, domanda 4):** prima le parole attese controllate dal codice, poi, per le sole risposte dubbie, un giudice Claude che passa dal gateway (`packages/policy`), solo sui casi inventati di `evals/memory` e solo per la prova: in produzione la memoria non ha giudice. Si collega al passo (c) come implementazione di `MemoryJudge`; in questo ramo c'è solo «nessun giudice», senza chiamate a Claude. Perché il gateway li lasci passare, i file dei casi devono restare tutti dati inventati L0: le etichette L1-L3 degli episodi sono simulate per provare la memoria, non etichette di dati veri; al giudice vanno solo domanda, `reference` e risposta. Il passo (c) aggiunge una candidata alla volta a `CANDIDATES` in `packages/evals/src/memory-cli.ts`.

## 5. Domande per l'utente

Le stesse domande, con la stessa spiegazione, sono in `OPEN-QUESTIONS.md` (righe in «Decisioni aperte», blocchi in «Spiegazioni delle domande»).

1. **Memoria: quali candidate misurare per prime**
- Contesto: D-204 vuole la memoria migliore scelta con una prova misurata. Rifarla per ogni sistema costa ore di installazione e di prova; conviene partire da poche candidate. Mem0 nella versione gratuita da installare in casa non ha più il grafo (tolto ad aprile 2026), quindi non è più «Mem0 col grafo».
- Opzione consigliata: Graphiti, Hindsight e la nostra — si misurano il grafo con le date (Graphiti), la memoria su PostgreSQL già pronta (Hindsight) e una versione nostra minima come riferimento; circa 30-40 h in tutto.
- Opzione: Anche Mem0 come quarta — si aggiunge la memoria «solo vettori» più usata; 6-8 h in più, risultato già prevedibile sulle domande con le date.
- Opzione: Solo Graphiti e Hindsight — niente prototipo nostro; prova più corta, ma senza un riferimento per dire se una memoria esterna vale le sue dipendenze.
- Esempio: Alla domanda finta «chi era il referente di Ortofrutta Bellini a febbraio?» Graphiti dovrebbe rispondere «Giada Morra» dalla data dell'arco; si vede se Hindsight e la nostra ci arrivano, e in quanti secondi sul Mac.

2. **Memoria: Python per la prova**
- Contesto: Graphiti e Hindsight sono scritti in Python; oggi Arianna ammette Python solo per la voce e per il secondo controllo dei dati personali, ciascuno col suo ambiente. Per la prova serve installarli da qualche parte, in modo ripetibile.
- Opzione consigliata: Ambiente di prova solo in data — ogni candidata in `data/memlab/<id>` con `uv` e versioni fissate, fuori da git; in git solo i casi e l'adattatore in TypeScript; dopo la prova si cancella. Il Python in git si decide solo se una candidata in Python vince.
- Opzione: Cartella apps/memlab in git — `pyproject.toml` e `uv.lock` in git come `apps/guard`; prova ripetibile da chiunque, ma un terzo ambiente Python nel repository già da ora.
- Opzione: Niente Python — si misurano solo la nostra e Mem0 per TypeScript; niente grafo con le date nella prova.
- Esempio: Con la prima opzione `data/memlab/graphiti/venv` e `data/memlab/hindsight/venv` esistono solo sul Mac di sviluppo; `pnpm eval:memory --candidate graphiti` li usa, e un `rm -rf data/memlab` li toglie del tutto.

3. **Memoria: database della prova**
- Contesto: Hindsight, Mem0 e la nostra hanno bisogno di PostgreSQL con pgvector, che il database di Arianna oggi non ha (l'immagine di `compose.yaml` è senza). Graphiti vuole invece un database a grafo.
- Opzione consigliata: Database separati solo per la prova — un PostgreSQL con pgvector e, per Graphiti, FalkorDB Lite incorporato, ognuno in `data/memlab/`, su una porta locale diversa; il database di Arianna non si tocca.
- Opzione: pgvector subito nel database di Arianna — si cambia l'immagine di `compose.yaml` adesso (serve comunque alla ricerca ibrida della Fase 2); la prova usa un database a parte nello stesso PostgreSQL.
- Opzione: Neo4j per Graphiti — il motore più provato per Graphiti, ma Java in Docker e più RAM sul Mac da 32 GB.
- Esempio: Con la prima opzione `docker ps` durante la prova mostra `arianna` (quello di sempre) e `arianna-memlab-hindsight` sulla porta 54339, che si spegne e si cancella a prova finita.

4. **Memoria: chi giudica le risposte** — decisa il 2026-10-24: parole attese più Claude via gateway, solo per la prova (D-307).

## Fonti

- Graphiti: [README](https://github.com/getzep/graphiti), [release](https://github.com/getzep/graphiti/releases), [edges.py](https://github.com/getzep/graphiti/blob/main/graphiti_core/edges.py), [search_filters.py](https://github.com/getzep/graphiti/blob/main/graphiti_core/search/search_filters.py), [Zep, arXiv 2501.13956](https://arxiv.org/abs/2501.13956) ([HTML](https://arxiv.org/html/2501.13956)), [Thoughtworks Radar](https://www.thoughtworks.com/en-us/radar/platforms/graphiti), [FalkorDB](https://github.com/FalkorDB/FalkorDB).
- Hindsight: [README](https://github.com/vectorize-io/hindsight), [release](https://github.com/vectorize-io/hindsight/releases), [installazione](https://hindsight.vectorize.io/developer/installation), [retain](https://hindsight.vectorize.io/developer/api/retain), [arXiv 2512.12818](https://arxiv.org/abs/2512.12818), [risultati](https://benchmarks.hindsight.vectorize.io/).
- Mem0: [README](https://github.com/mem0ai/mem0), [release](https://github.com/mem0ai/mem0/releases), [grafo tolto dalla versione aperta](https://docs.mem0.ai/open-source/graph_memory/overview), [changelog](https://docs.mem0.ai/changelog), [pgvector](https://docs.mem0.ai/components/vectordbs/dbs/pgvector), [Ollama](https://docs.mem0.ai/components/llms/models/ollama), [valutazione](https://docs.mem0.ai/core-concepts/memory-evaluation), [arXiv 2504.19413](https://arxiv.org/abs/2504.19413), [issue 2062 sulla telemetria](https://github.com/mem0ai/mem0/issues/2062).
- Cognee: [README](https://github.com/topoteretes/cognee), [release](https://github.com/topoteretes/cognee/releases), [rapporto BEAM](https://github.com/topoteretes/cognee/blob/main/cognee/eval_framework/beam/REPORT.md), [arXiv 2505.24478](https://arxiv.org/abs/2505.24478).
- Confronto indipendente: [Wolff e Bennati, arXiv 2601.07978](https://arxiv.org/abs/2601.07978).
- Altre: [MemOS](https://github.com/MemTensor/MemOS), [Letta](https://github.com/letta-ai/letta) e [self-hosting](https://docs.letta.com/guides/selfhosting), [MemGPT, arXiv 2310.08560](https://arxiv.org/abs/2310.08560), [LightRAG](https://github.com/HKUDS/LightRAG), [MemoRAG](https://github.com/qhjqhj00/MemoRAG), [A-MEM](https://github.com/agiresearch/A-mem), [Supermemory](https://supermemory.ai/research/longmembench).
- Benchmark: [LongMemEval, arXiv 2410.10813](https://arxiv.org/abs/2410.10813), [LoCoMo, arXiv 2402.17753](https://arxiv.org/abs/2402.17753); DMR è nell'articolo di MemGPT.
