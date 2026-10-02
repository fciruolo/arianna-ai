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
    models.manifest.yaml  # elenco modelli: nome, runtime, URL, dimensione, sha256, ruolo
    arianna.toml          # percorsi, porte, opzioni, allowlist dei repository; nessun segreto
    labels.toml           # regole di etichetta per cartella e sorgente
  scripts/                # installer e utilità
```

Regola: nessun percorso assoluto nel codice; tutto è relativo a `ARIANNA_HOME`, impostabile da variabile d'ambiente.

## Installer (`arianna install`)

1. Verifica prerequisiti: Node, pnpm, Docker, spazio libero, RAM, architettura.
2. Crea la struttura `data/` e `config/` se mancano.
3. Legge `models.manifest.yaml` e scarica solo i modelli mancanti in `data/models/`, con ripresa, verifica sha256 e barra di avanzamento.
4. Configura il runtime locale (oMLX) perché punti a `data/models/`; se il runtime non lo consente, crea collegamenti simbolici. **Da verificare** nelle opzioni di oMLX.
5. Avvia Postgres e Qdrant con Docker Compose usando volumi dentro `data/`.
6. Applica le migrazioni e lancia `arianna doctor`: controlli di salute, modelli presenti, gateway attivo, catena di hash del registro eventi, test di contratto degli esecutori.
7. Non tocca mai le credenziali di Claude Code e Codex: il login resta manuale e a carico dell'utente.

Comandi collegati: `arianna doctor` (diagnosi), `arianna models pull|list|verify`, `arianna export`, `arianna import`.

## Wizard iniziale e impostazioni

**Wizard (`arianna init`, al primo avvio dopo `install`).** Procedura guidata a domande, in italiano, che scrive `config/arianna.toml`:

1. Cartella dei dati e controllo dello spazio libero.
2. Scelta dei modelli locali dal catalogo (vedi sotto), con avviso se non stanno nella RAM della macchina.
3. Esecutori cloud: abilita o no Claude Code e Codex; mostra le istruzioni di login manuale (il wizard non tocca le credenziali).
4. Livello di autonomia iniziale (A1 predefinito) e tetti di passi, tempo e costo.
5. Percorsi di sincronizzazione (es. Synology) con avvisi su ciò che non va sincronizzato.
6. Canali: chat web, Telegram (opzionale, canale esterno: al massimo L1, vedi D-016); voce e telefono rimandati alle fasi successive.
7. Riepilogo, `arianna doctor`, avvio.

Il wizard è rilanciabile (`arianna init --reconfigure`) e non sovrascrive nulla senza conferma.

**Impostazioni.** Ogni valore del wizard è modificabile dopo, in due modi equivalenti: file `arianna.toml` e pagina Impostazioni nella chat/HUD. Le modifiche sono validate (schema), applicate senza riavvio quando possibile e registrate nel registro eventi. Le impostazioni che toccano la privacy (livelli, regole di etichetta, gateway, allowlist dei repository, abilitazione degli esecutori cloud e dei canali esterni) richiedono una conferma esplicita e non si cambiano da un agente.

**Catalogo modelli curato (`config/models.catalog.yaml`).** Una lista corta scelta da te, non un elenco infinito. Ogni voce ha: id, famiglia, runtime, dimensione, RAM minima, ruoli adatti (`orchestrator`, `extractor`, `embedder`, `voice`), URL e sha256, stato (`verified` se ha superato gli eval, `experimental` altrimenti). Oggi contiene **solo il Qwen che hai già provato**; versione e quantizzazione esatte vanno copiate dalla tua configurazione oMLX nel task 1.17. Per aggiungere un modello: si inserisce la voce, si lancia `pnpm eval` sui gruppi router ed estrazione, e solo dopo passa a `verified`. Nelle impostazioni si assegna un modello a ogni ruolo scegliendo fra quelli del catalogo.

## Modelli: manifest, non copia

I pesi sono decine di GB. Strategia: nel repository e nella cartella sincronizzata viaggia il **manifest**, i pesi si scaricano di nuovo dove servono. Sul Mac si usano modelli MLX; su un server Linux serviranno formati e runtime diversi (llama.cpp o vLLM), quindi il manifest ha una voce per runtime e lo stesso ruolo (es. `orchestrator`, `extractor`, `embedder`).

Primo manifest: i modelli Qwen che usi già; nomi e versioni esatte da copiare dalla tua configurazione oMLX nel task 1.17. Fino ad allora (Fase 1A) il modello locale si configura a mano in `arianna.toml`.

## Sincronizzazione con Synology Drive

| Cosa | Sincronizzare? | Note |
| --- | --- | --- |
| Codice, docs, `config/`, `agents/` | Sì (meglio via git) | Con Drive, escludi `node_modules` e build |
| `data/kb/`, `data/archive/` | Sì | Contenuti L2: solo verso il tuo NAS, mai verso cloud di terzi senza cifratura |
| `data/models/` | No | Si riscaricano dal manifest; escludere per risparmiare spazio e banda |
| `data/postgres/`, `data/qdrant/` | **Mai dal vivo** | Rischio di corruzione; si sincronizzano i dump in `backups/` |
| `data/vault/` | Sì, cifrato | La chiave `age` resta fuori dalla cartella sincronizzata |
| `.git` | Con cautela | Conflitti di sincronizzazione; preferire un remote git e non sincronizzare `.git` |

Per privacy: Synology Drive sul tuo NAS è locale e va bene per L2; iCloud, Google Drive o altri cloud di terzi ricevono L2, quindi o cifratura prima della sincronizzazione o esclusione di `archive/` e `kb/`.

## Export e import

- `arianna export`: dump di Postgres, snapshot Qdrant, archivio, KB, configurazione e vault cifrato in `backups/arianna-AAAA-MM-GG.tar.age`. I modelli non sono inclusi, ma il manifest sì.
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
- Differenze Mac/Linux nei runtime dei modelli: le prestazioni cambiano, il manifest per runtime attenua il problema.
- Sincronizzazione che copia database aperti o che porta L2 su cloud di terzi: regole nella tabella sopra e controllo in `doctor`.
