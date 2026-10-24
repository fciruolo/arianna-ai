# I-22, Arianna agisce sul Mac: studio e proposta

Stato: **proposta di Claude, da decidere** (2026-10-24). Nessun codice. Le domande per l'utente sono in fondo a `docs/PROPOSTE.md`, sezione «I-22».

## In una frase

Arianna (modello locale) riceve un piccolo insieme di **strumenti tipizzati del core** per le cartelle del Mac scelte dall'utente: elencare e leggere senza chiedere, e per ogni azione che cambia qualcosa (creare una cartella, spostare, rinominare, copiare, scrivere un file nuovo, mettere nel Cestino, aprire) una **scheda di approvazione in italiano scritta dal codice**, con sotto il comando equivalente; niente shell libera, niente cancellazione definitiva, niente rete. Il terminale vero con il comando esatto arriva solo dopo, come tappa a parte, con un elenco chiuso di programmi e la sandbox di macOS.

## La richiesta

L'utente (2026-10-24): Arianna deve poter rispondere a «che file ho sulla Scrivania?» e fare «creami una cartella Prova sulla Scrivania», **chiedendo sempre il permesso prima di ogni azione** («voglio dare il comando mkdir …/Desktop/Prova, posso?» → sì → lo esegue). Chiede se in rete o nei progetti che segue (OpenWork, OpenBot, OpenDots, OpenMuse e l'account CopilotKit) c'è già una soluzione, e vuole «una soluzione definitiva ma solida».

## Cosa c'è già in Arianna

- **Orchestratore locale con strumenti a schema vincolato** (`TOOL_ARGS` in `packages/agents/src/protocol.ts`, registro chiuso in `packages/agents/src/tools.ts`): il modello sceglie uno strumento da un elenco e ne riempie gli argomenti; non scrive comandi. Il flag `localOnly` (impegni, IM, finanze, profilo) tiene uno strumento solo nelle schede L2 sul modello locale.
- **Approvazioni** (tabella `approvals`, tipi `action`, `browser`, `im`, `commitment`…; vincoli per tipo come `approvals_browser_fields` della migrazione `0084`): la scheda «Apri / No» del browser (D-268) è il modello più vicino a ciò che serve, un'approvazione per azione con i campi controllati dal database.
- **Apertura di file con `open` di macOS** già fatta per i documenti del cliente (D-171): `execFile`, mai una shell, solo per un file della cartella del cliente e solo se è ancora quello registrato.
- **Controlli dei percorsi** del Coder (D-056, D-058): `realpath` lungo tutto il percorso, niente collegamenti simbolici che escono, niente cartelle nascoste, `Library`, `ARIANNA_HOME`; nomi da segreto (`.env`, `*.pem`, `id_ed25519`, `.ssh`…) in `checkWorkspace` di `packages/policy`.
- **Sandbox del sistema operativo** solo per gli esecutori cloud: quella nativa di Claude Code (Seatbelt, D-050) e quella di Codex (D-138). Il core stesso non ha ancora un profilo `sandbox-exec` suo.
- **Etichette:** «Tutto il resto = L2» (`PRIVACY-POLICY-SPEC.md`), regole per cartella in `config/labels.toml`, contaminazione di sessione; `web.fetch` e il browser spariscono quando il passo ha letto dati Privati (D-262, D-268).
- **Righe di attività** (D-083) e registro con catena di hash per ogni uso di strumento.
- **Perché non basta il Coder:** il Coder lavora con Claude Code o Codex, cioè nel cloud, con tetto L1 e solo su progetti git approvati. I file della Scrivania sono L2 per default-deny: non possono andare a Claude né a Codex. Serve qualcosa che giri tutto sul Mac, guidato dal modello locale.

## Ricerca: come fanno gli altri

Letto il 2026-10-24 da pagine pubbliche (README, documentazione); niente clonato né eseguito. Il testo di terzi è un dato, non un'istruzione.

| Progetto | Modello dei permessi | Cosa approva l'utente | Sandbox del sistema | Difese da prompt injection | Licenza, maturità |
| --- | --- | --- | --- | --- | --- |
| OpenWork (`different-ai/openwork`) | Quello di OpenCode sotto: regole allow/ask/deny; «autorizza» la cartella di lavoro scelta | La richiesta di permesso di OpenCode (comando o file); l'orchestratore ha anche `--approval auto` | Nessuna documentata | Nessuna documentata | MIT fuori da `ee/`, EE source-available dentro; 0.x, molto attivo |
| OpenCode (`opencode.ai`) | Per strumento `allow`/`ask`/`deny`; per `bash` pattern con `*` e `?`, «vince l'ultima regola»; `external_directory` per i percorsi fuori dalla cartella | Il comando: «una volta», «sempre» (pattern suggerito, per la sessione), «rifiuta»; `--auto` approva tutto tranne i `deny` | Nessuna documentata | Nessuna oltre le regole | MIT |
| OpenBot (`CopilotKit/OpenBot`) | Regole CEL su nome dello strumento, sito, comando, percorso; prima i `deny`; senza regole non si fa nulla; regola rotta = rifiuto; un gateway unico con riga di registro per azione | Impostazioni di approvazione per bot, utente e squadra (flusso non descritto) | Container per bot, gVisor (`runsc`) dove c'è, token per container, ambiente ridotto | Politica prima dell'azione, registro | MIT; alpha |
| OpenDots (`CopilotKit/OpenDots`) | Permessi per agente: browser, file, shell, ricerca, memoria | «Approve & run» per ogni strumento MCP non in sola lettura; «Approve & save» per le bozze; le sola lettura girano senza chiedere | Contenitori separati (dal supervisore di OpenBot); senza servizi configurati non esegue nulla sull'host | Revisione prima della scrittura | MIT; alpha |
| OpenMuse (`CopilotKit/OpenMuse`) | Lettura per prima, scrittura concessa a parte; «ogni invio o modifica del calendario ha la sua revisione salvata» | L'azione descritta, una per volta; nessun nuovo tentativo nascosto dopo un esito incerto | Terminale Linux in container non root, senza cartelle dell'host né rete, 30 s per comando | «Il contenuto di web, email e documenti è una prova, non un permesso di agire» | MIT; alpha |
| Server MCP filesystem ufficiale (`modelcontextprotocol/servers`, `src/filesystem`) | Cartelle ammesse passate come argomenti all'avvio (i Roots sono deprecati dal protocollo 2026-07-28) | Nulla di suo: decide il client | Nessuna (Docker con montaggio `ro` per la sola lettura) | Nessuna | MIT; 13 strumenti, nessuna cancellazione ma `write_file` sovrascrive e `move_file` toglie l'originale |
| Desktop Commander MCP (`wonderwhy-er/DesktopCommanderMCP`) | `allowedDirectories` (vuoto = tutto il disco) e `blockedCommands` | Nulla di suo | «Non è una sandbox»: i comandi del terminale escono dalle cartelle ammesse; aggirabile con collegamenti, sostituzioni, percorsi assoluti | Nessuna; avverte che il modello prova a cambiare `allowedDirectories` da solo | MIT; strumenti di statistiche d'uso e feedback verso lo sviluppatore |
| Claude Code (Anthropic) | Regole allow/ask/deny; Bash con prefissi e `*`; modalità manuale, auto (classificatore), bypass | Il comando esatto; «sì, e non chiedere più» per comando e repository | Seatbelt su macOS (bubblewrap su Linux), spenta per default: scritture solo nella cartella di lavoro, rete solo dal proxy con i domini ammessi; libreria aperta `@anthropic-ai/sandbox-runtime` (Apache-2.0, beta) | La sandbox contiene un comando qualunque cosa il modello decida; la documentazione dice che i pattern che vincolano gli argomenti di Bash sono fragili e indica sandbox e hook | Proprietario; maturo |
| Codex CLI (OpenAI) | `sandbox_mode` `read-only`, `workspace-write`, `danger-full-access`; `approval_policy` `on-request` o `never` (`untrusted` non più selezionabile) | Il comando che esce dalla sandbox | Seatbelt su macOS «out of the box» | La sandbox prima di tutto | Apache-2.0; maturo |
| Goose (Block) | Modalità autonoma (predefinita), approvazione manuale, approvazione «intelligente» a rischio, solo chat | Lo strumento | Nessuna di suo | Rilevamento a pattern (e facoltativo a ML), «una salvaguardia, non una garanzia»; «Adversary Mode» con revisore che, se fallisce, lascia passare | Apache-2.0; CVE-2026-109561 (12 ottobre 2026): in approvazione manuale strumenti segnati «sola lettura» giravano senza chiedere, corretto in 1.44.0 |
| Open Interpreter | Ora versione Rust basata su Codex: permessi, hook, approvazioni ereditati | Il comando | «Sandbox nativa» su macOS, Linux, Windows (quella di Codex) | Quelle di Codex | Apache-2.0; il vecchio Python è un fork della comunità |
| Claude Cowork (Anthropic) | Cartelle collegate dall'utente; approvazione obbligatoria per ogni cancellazione definitiva, in qualunque modo; modi «approva a mano», «approva in automatico» (con controllo), «salta tutte» | L'azione, «Allow» per cancellare | Prima una VM Linux locale, dal 6 ottobre 2026 per Pro e Max in un ambiente cloud temporaneo; i file locali vengono elaborati sui server di Anthropic | Consiglio all'utente di «sorvegliare azioni sospette»; caso PromptArmor (gennaio 2026): un documento con istruzioni nascoste ha fatto uscire file verso `api.anthropic.com`, che era fra i domini ammessi; caso SharedRoot (luglio 2026, CVE-2026-46331): dalla VM locale si arrivava a tutti i file del Mac perché il disco era montato in scrittura | Proprietario |
| Apple: Comandi Rapidi e AppleScript | `shortcuts run "Nome"` esegue un comando rapido dell'utente; `osascript` comanda le app con il permesso «Automazione» di macOS (TCC) | Il comando rapido scelto; per AppleScript il consenso TCC una volta per app | TCC protegge Scrivania, Documenti, Scaricati: la prima lettura chiede il permesso all'app responsabile del processo | Nessuna: AppleScript può mandare mail, aprire siti, scrivere ovunque | Di sistema |

**Lavori di ricerca da cui partire.**
- **Lethal trifecta** (Simon Willison, 2025-06-16, `https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/`): dati privati, contenuti non fidati, comunicazione esterna; l'unica difesa sicura è non metterli insieme, i filtri che fermano «il 95%» degli attacchi «sono un voto insufficiente». Arianna lo applica già per scheda (`AGENT-CARDS.md`).
- **CaMeL** (Debenedetti, Shumailov, Carlini, Tramèr e altri, Google DeepMind/ETH, arXiv 2503.18813, 2025-03-24, rivisto il 2025-06-24): il flusso di controllo viene solo dalla richiesta fidata dell'utente, i dati non fidati non possono cambiare quali strumenti si chiamano; capacità che impediscono ai dati privati di uscire; 77% dei compiti di AgentDojo con sicurezza dimostrabile contro 84% senza difese.
- **Design Patterns for Securing LLM Agents against Prompt Injections** (IBM, Invariant Labs, ETH, Google, Microsoft; arXiv 2506.08837, giugno 2025): sei schemi; i più utili qui sono **Action-Selector** (il modello sceglie azioni da un elenco senza vederne il risultato), **Plan-Then-Execute** (le azioni si decidono prima di leggere contenuti non fidati) e **Context-Minimization**.

**Fonti** (lette il 2026-10-24):
- `https://github.com/different-ai/openwork` e `https://cdn.jsdelivr.net/gh/different-ai/openwork@dev/README.md`
- `https://opencode.ai/docs/permissions/`
- `https://github.com/CopilotKit/OpenBot`, `https://github.com/CopilotKit/OpenDots`, `https://github.com/CopilotKit/OpenMuse`
- `https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem`
- `https://github.com/wonderwhy-er/DesktopCommanderMCP`
- `https://code.claude.com/docs/en/sandboxing`, `https://code.claude.com/docs/en/permissions`, `https://github.com/anthropic-experimental/sandbox-runtime`
- `https://learn.chatgpt.com/docs/sandboxing` (Codex)
- `https://goose-docs.ai/docs/guides/goose-permissions`, `https://goose-docs.ai/docs/guides/security/prompt-injection-detection`, `https://www.vulncheck.com/advisories/goose-from-1.28.0-before-1.44.0-manual-approval-bypass-via-read-only-tool-annotations`
- `https://github.com/openinterpreter/open-interpreter`
- `https://support.claude.com/en/articles/13364135-use-cowork-safely`, `https://labs.cloudsecurityalliance.org/research/csa-research-note-claude-cowork-sharedroot-sandbox-escape-20/`, `https://9to5mac.com/2026/07/27/claude-cowork-escaped-sandbox-on-mac-gain-full-access-to-all-files/`
- `https://arxiv.org/abs/2503.18813`, `https://simonwillison.net/2025/Jun/13/prompt-injection-design-patterns/`
- Sul Mac dell'utente (macOS 26.6.2, `man`): `/usr/bin/trash` «sposta file e cartelle nel Cestino dell'utente», presente da macOS 15.0; `/usr/bin/sandbox-exec` segnato **DEPRECATED** dalla sua pagina di manuale (resta quello che usano Claude Code, Codex e Chromium); presenti anche `/usr/bin/shortcuts`, `/usr/bin/osascript`, `/usr/bin/mdfind`.

### Cosa se ne impara

1. **Nessuno dei progetti seguiti risolve il caso di Arianna.** OpenBot, OpenDots e OpenMuse agiscono in un **container**, non sul Mac dell'utente: è il «computer dell'agente» che Arianna ha già con D-095/D-264. OpenWork agisce sul Mac ma senza sandbox né etichette (D-093 l'ha già escluso).
2. **Approvare il comando grezzo è il modello di chi ha un utente programmatore** (Claude Code, Codex, OpenCode, Open Interpreter). Tutti aggiungono una sandbox del sistema perché il comando da solo non si capisce (Claude Code lo scrive: i pattern sugli argomenti sono fragili). Desktop Commander, che ha solo elenchi di comandi bloccati, dichiara di non essere una sandbox.
3. **Approvare l'azione descritta è il modello dei prodotti per non programmatori** (Cowork, OpenDots, OpenMuse): «Approve & run», «Allow» per cancellare, una revisione per ogni scrittura. OpenMuse aggiunge la regola giusta per noi: il contenuto letto è prova, non permesso.
4. **I filtri a modello non bastano** (Goose: «salvaguardia, non garanzia»; il revisore che fallisce lascia passare; CVE di ottobre sulle annotazioni di sola lettura). La sicurezza deve stare nel codice: elenco chiuso di azioni, percorsi controllati, nessuna uscita.
5. **Cowork mostra i due errori da evitare:** un dominio ammesso che serve anche a far uscire dati (PromptArmor) e una «gabbia» con il disco intero montato dentro (SharedRoot). Per noi: nessuna rete dagli strumenti del Mac, e cartelle ammesse controllate dal core su ogni percorso, non da una gabbia che vede tutto.
6. **Il server MCP filesystem ufficiale ha la forma giusta** (cartelle ammesse, strumenti piccoli) ma non le regole che servono ad Arianna: sovrascrive, `move_file` toglie l'originale, niente Cestino, niente etichette né approvazioni.

## Le etichette dei file del Mac

- **Tutto ciò che si legge dalle cartelle del Mac è L2** (Privato), nomi dei file compresi: è la riga «Tutto il resto» di `PRIVACY-POLICY-SPEC.md` (default-deny). L3 non lo legge nessun modello, quindi una cartella con segreti semplicemente non si ammette. Un'etichetta più bassa di L2 per una cartella sarebbe una scelta esplicita dell'utente nelle Impostazioni, registrata come le altre impostazioni di privacy, mai di un agente. Proposta: per ora niente cartelle sotto L2.
- **Conseguenze, già scritte nelle regole:** gli strumenti del Mac sono `localOnly` (solo schede L2 sul modello locale, mai Claude né Codex); il passo che li usa è Privato e da lì `web.fetch` e il browser spariscono (D-262, D-268); un brief verso il Coder che contiene un nome di file passa dal gateway e viene fermato come ogni L2, salvo declassamento approvato.
- **Contenuto non fidato:** un file della Scrivania può venire da chiunque (un PDF scaricato, una mail salvata). Il contenuto letto entra nel contesto come dato fra delimitatori, come le pagine KB, e il passo si segna «ha letto contenuti del Mac».

## Opzioni

### (a) Strumenti tipizzati del core

Strumenti nuovi nel registro, `localOnly`, eseguiti dal core in Node (`node:fs/promises`, `execFile` per `open` e `trash`), mai da una shell:

| Strumento | Cosa fa | Approvazione |
| --- | --- | --- |
| `mac.list` | Elenca una cartella ammessa (nome, tipo, dimensione, data), al più 200 voci, senza file nascosti | no (domanda 3) |
| `mac.info` | Dettagli di un file o di una cartella | no |
| `mac.read` | Legge un file di testo (txt, md, csv, json…) fino a un tetto; PDF e documenti con gli estrattori che la KB già usa | no |
| `mac.find` | Cerca per nome (e poi per contenuto con `mdfind -onlyin` sulle sole cartelle ammesse) | no |
| `mac.mkdir` | Crea una cartella; mai sopra una che esiste | sì |
| `mac.move` | Sposta o rinomina; mai sopra un file che esiste | sì |
| `mac.copy` | Copia; mai sopra un file che esiste | sì |
| `mac.write` | Crea un file di testo nuovo; mai sovrascrivere (una modifica è «salva come nuovo» o una tappa futura con l'anteprima delle differenze) | sì |
| `mac.trash` | Mette nel Cestino con `/usr/bin/trash`; **nessuna cancellazione definitiva, mai** | sì, sempre, anche con «sì per questa conversazione» |
| `mac.open` | Mostra nel Finder (`open -R`) o apre un documento con l'app predefinita; rifiuta i tipi che eseguono codice (`.app`, `.command`, `.sh`, `.tool`, `.terminal`, `.workflow`, `.scpt`, `.pkg`, `.dmg`, `.webloc`, `.inetloc`, `.fileloc`, `.url`, file eseguibili) e gli indirizzi web | sì |

**Regole dei percorsi, nel codice** (riuso di `openRepository`/`checkWorkspace`): ogni percorso dentro una cartella ammessa dopo `realpath`, anche il genitore di ciò che si crea; niente collegamenti simbolici che escono, niente nomi nascosti, nomi da segreto, `Library`, `ARIANNA_HOME`, `.git`; file aperti con `O_NOFOLLOW` e creati con `O_EXCL` come i documenti del cliente (D-171); il percorso si ricontrolla subito prima di eseguire, dopo il sì (un file cambiato fra la proposta e il sì fa scadere la scheda, come le approvazioni `workspace`). Le cartelle ammesse le sceglie l'utente in Impostazioni → Privacy («Cartelle del Mac»), mai un agente, come i `[[project]]`.

**La scheda.** La scrive il codice dagli argomenti, non il modello: «Arianna vuole **creare la cartella** "Prova" in **Scrivania**», sotto in piccolo il comando equivalente `mkdir ~/Desktop/Prova` (solo da leggere, non è ciò che si esegue), e «Sì / No». Se il passo ha letto contenuti del Mac o del web prima di proporre l'azione, la scheda lo dice: «Proposta dopo aver letto: note.txt». Più azioni dello stesso passo («sposta questi 12 file in Fatture 2026») vanno in una scheda sola con l'elenco, approvata o rifiutata tutta insieme.

**Annulla.** Ogni azione eseguita lascia una riga nel registro con ciò che serve a disfarla (spostamento al contrario, cartella vuota creata da togliere, file tolto dal Cestino nel suo posto): un pulsante «Annulla» sotto la riga di attività.

- **Sicurezza contro un contenuto che spinge un'azione:** alta. Il modello può solo scegliere da dieci azioni con argomenti tipizzati; nessuna apre la comunicazione esterna (niente rete, niente URL, niente eseguibili), quindi la scheda di Arianna resta con il lato `external_comms: false` e il trifecta rotto; il peggio che un documento ostile ottiene è proporre una scrittura o un Cestino dentro le cartelle ammesse, che l'utente vede descritta in chiaro e può annullare.
- **Chiarezza per l'utente:** la migliore; è ciò che ha chiesto, con il comando sotto per chi lo vuole vedere.
- **Lavoro:** 22-32 h (lettura 8-12 h, scritture e scheda 10-14 h, Annulla e registro 4-6 h).
- **Riuso:** registro e `TOOL_ARGS`, `localOnly`, tabella `approvals` con un tipo `mac` e i suoi vincoli (come `browser`, migrazione nuova), schede della chat, controlli dei percorsi di `packages/policy` ed `executors`, `execFile` di D-171, righe di attività D-083, estrattori della KB. Nessuna dipendenza nuova.
- **Limite:** fa solo ciò che è nell'elenco. Convertire un video o ridimensionare cento foto non c'è.

### (b) Terminale con approvazione del comando esatto e sandbox

Arianna propone un comando, la scheda lo mostra così com'è («Arianna vuole eseguire: `mkdir ~/Desktop/Prova`»), con il sì il core lo esegue.

Per essere solido non basta l'elenco a pattern (OpenCode, Desktop Commander): serve
1. **niente shell**: il comando come vettore di argomenti (`execFile`), così pipe, `&&`, `$(…)`, reindirizzamenti e variabili non esistono;
2. **programmi da un elenco chiuso** con percorso assoluto (`/bin/ls`, `/bin/mkdir`, `/bin/mv`, `/bin/cp`, `/usr/bin/sips`, `/opt/homebrew/bin/ffmpeg`…), con argomenti vietati per programma (per esempio `find -exec`, `-delete`), mai interpreti (`sh`, `python`, `node`, `osascript`), mai `curl`, `ssh`, `open` di URL, `rm`;
3. **sandbox del sistema**: un profilo `sandbox-exec` (Seatbelt) scritto dal core per ogni comando, con rete negata, scrittura solo nelle cartelle ammesse, lettura solo nelle cartelle ammesse e nella toolchain, come fa Claude Code. `sandbox-exec` è deprecato da Apple ma resta quello che usano Claude Code, Codex e Chromium; `@anthropic-ai/sandbox-runtime` lo incapsula (Apache-2.0, beta, dipendenza nuova da annotare) oppure si scrive il profilo noi (poche decine di righe, test con il canarino come D-050);
4. tempo massimo, uscita troncata, ambiente pulito.

- **Sicurezza:** buona con tutti e quattro i punti, debole senza. Resta il problema che il modello locale da 35B compone comandi e l'utente deve capirli: un `mv` con l'ordine degli argomenti sbagliato si approva senza accorgersene.
- **Chiarezza:** è la forma che l'utente ha scritto come esempio, ma per azioni oltre `mkdir` diventa illeggibile (`ffmpeg -i … -vf scale=…`). Il rischio «fatica da approvazione» è documentato da tutti.
- **Lavoro:** 18-26 h (esecutore senza shell e elenco 6-8 h, profilo Seatbelt e canarini 8-12 h, scheda e uscita 4-6 h).
- **Riuso:** la conoscenza del profilo di D-050/D-138 e i canarini; il resto è nuovo. Nessun Annulla possibile in generale.

### (c) Un server MCP esistente dietro il gateway e le approvazioni

Il core diventa client MCP del server filesystem ufficiale (o di Desktop Commander) avviato con le cartelle ammesse, e mette le sue approvazioni davanti agli strumenti di scrittura.

- **Contro:** il server legge dati L2 per natura, mentre `SPEC.md` vuole ogni server MCP di terzi «in un container senza accesso a dati privati»; serve un client MCP nel core (oggi Arianna ha solo il suo server); dipendenza nuova eseguita con `npx` e aggiornata da terzi (catena di fornitura su un processo che vede la Scrivania); gli strumenti non hanno le regole che vogliamo (sovrascrittura, nessun Cestino), quindi andrebbero filtrati argomento per argomento, cioè riscritti a metà. Desktop Commander in più ha un terminale che esce dalle cartelle ammesse e strumenti di statistiche verso lo sviluppatore: escluso.
- **Lavoro:** 14-20 h, ma con meno controllo di (a).
- **Utile come riferimento**: nomi e forma degli strumenti del server ufficiale (`list_directory`, `get_file_info`, `search_files`, `create_directory`, `move_file`) per scrivere i nostri.

### (d) Ibrido: (a) subito, (b) ristretto più tardi, Comandi Rapidi scelti dall'utente

(a) come base per tutto ciò che è «Finder»; poi, solo se servirà, (b) nella forma stretta (niente shell, elenco chiuso di programmi, Seatbelt senza rete) per i lavori che gli strumenti non coprono, con la scheda che mostra il comando esatto; e i **Comandi Rapidi** dell'utente come strumento `mac.shortcut`: l'utente sceglie in Impostazioni quali comandi rapidi Arianna può lanciare (per nome), ognuno con approvazione. AppleScript libero resta escluso.

- **Sicurezza:** quella di (a) per l'uso quotidiano; quella di (b) solo per i comandi avanzati, che restano rari e sempre con il comando visibile.
- **Lavoro:** 22-32 h per (a), poi 18-26 h per (b) ristretto e 4-6 h per i Comandi Rapidi, quando servono.

### Alternativa scartata: Codex o Claude Code sulle cartelle del Mac

Usare il Coder (Claude Code o Codex) confinato alla Scrivania darebbe subito la shell con la sandbox. Ma è cloud: i nomi e il contenuto dei file L2 andrebbero ad Anthropic o OpenAI, che è esattamente ciò che le regole vietano (e ciò che il caso PromptArmor di Cowork mostra). Codex con un fornitore locale (oMLX) sarebbe ammissibile per la privacy, ma `codex exec` non ha approvazioni interattive (`approval_policy="never"`), e il modello locale guiderebbe una shell generale: si torna a (b) con meno controllo. Da riconsiderare solo se Codex con fornitore locale diventa un esecutore di Arianna (`OPEN-QUESTIONS.md`).

### Confronto

| | (a) Strumenti | (b) Terminale | (c) MCP di terzi | (d) Ibrido |
| --- | --- | --- | --- | --- |
| Contenuto ostile che spinge un'azione | Solo dieci azioni senza rete, scheda chiara, Annulla | Contenuto dalla sandbox, ma l'utente deve leggere il comando | Dipende dal filtro sopra un codice di terzi | Come (a); (b) solo su richiesta |
| Chiarezza della scheda | Frase in italiano + comando equivalente | Comando esatto | Come (a) se riscritta | Come (a), comando esatto solo per i casi avanzati |
| Cosa può fare | Le azioni del Finder | Tutto ciò che fanno i programmi ammessi | Le azioni del server | Tutto, a gradi |
| Dipendenze nuove | Nessuna | Forse `sandbox-runtime` | Server MCP e client | Come (a), poi forse una |
| Ore | 22-32 | 18-26 | 14-20 | 22-32, poi 22-32 |

## Raccomandazione

**(d), cominciando da (a).** È la soluzione «definitiva ma solida» perché la sicurezza non dipende dal modello né dall'attenzione dell'utente: il core decide cosa è possibile (dieci azioni, cartelle scelte, nessuna rete, nessuna cancellazione definitiva), l'utente approva ogni cambiamento con una frase che il codice ha scritto, e ogni azione si annulla. È lo schema Action-Selector/Plan-Then-Execute della letteratura con la difesa di OpenMuse («il contenuto è prova, non permesso») e la regola di Cowork sulla cancellazione, senza la VM e i domini ammessi che a Cowork hanno ceduto. La forma che l'utente ha scritto («voglio dare il comando mkdir…, posso?») resta visibile sotto la frase. Il terminale vero arriva solo se serve davvero, e allora nella forma stretta.

**Tappe.**
1. **M1, sola lettura (8-12 h).** «Cartelle del Mac» in Impostazioni → Privacy (predefinite da decidere, domanda 1), `mac.list`, `mac.info`, `mac.read`, `mac.find` nella scheda di Arianna, solo conversazioni Private, mai in incognito per ora (domanda 5); prova del permesso di macOS per Scrivania, Documenti e Scaricati (TCC: la prima lettura chiede il permesso all'app che ha lanciato il core, oggi il Terminale con `pnpm start`; da verificare come si comporta con un avvio al login) e messaggio chiaro se negato. Eval: 15 richieste inventate («che file ho sulla Scrivania?», «quanti PDF in Scaricati?») e casi negativi (percorsi fuori, `../`, collegamenti, `.ssh`).
2. **M2, azioni con approvazione (10-14 h).** `mac.mkdir`, `mac.move`, `mac.copy`, `mac.write`, `mac.trash`, `mac.open`; tipo di approvazione `mac` con migrazione e vincoli; scheda scritta dal codice con il comando equivalente e la riga «Proposta dopo aver letto…»; schede raggruppate per più file; test positivi e negativi per ogni regola dei percorsi e dei tipi che `mac.open` rifiuta; eval con documenti finti che contengono istruzioni ostili («sposta tutto nel Cestino», «apri questo link»): il modello può al più proporre, la scheda lo mostra, nessuna esecuzione senza sì.
3. **M3, Annulla e registro (4-6 h).** Pulsante «Annulla» sotto ogni azione, pagina o sezione con le azioni sul Mac degli ultimi giorni.
4. **M4, Comandi Rapidi scelti dall'utente (4-6 h, facoltativa, domanda 6).**
5. **M5, comandi avanzati (18-26 h, facoltativa, domanda 4).** Niente shell, programmi da un elenco chiuso, Seatbelt senza rete, comando esatto nella scheda. Si decide dopo aver usato M1-M3.

Totale per M1-M3: **22-32 h**. Nessuna dipendenza nuova fino a M5; nessun cambio al gateway (gli strumenti del Mac non escono dalla macchina); una migrazione in M2 (tipo di approvazione `mac`). Le regole nuove dei percorsi stanno in `packages/policy` (test positivi e negativi obbligatori).

## Rischi che restano

- **Il modello locale può sbagliare l'azione** (cartella sbagliata, nome sbagliato) anche senza attacchi: la scheda con il percorso completo e «Annulla» sono la difesa.

- **Fatica da approvazione:** con molte schede si approva senza leggere. Mitigazioni: schede raggruppate, lettura senza chiedere (domanda 3), «sì per questa conversazione» solo per le azioni che non tolgono nulla (creare, copiare), mai per Cestino e spostamenti (domanda 2 e 3).
- **Un file aperto con la sua app** (`mac.open`) può a sua volta caricare contenuti dalla rete (un HTML con immagini remote, un documento con collegamenti): è l'app dell'utente, non Arianna, e il contenuto non torna al modello; i tipi che eseguono codice sono rifiutati. Da valutare se limitare `mac.open` al solo «Mostra nel Finder» in M2.
- **Accesso remoto (D-292):** le schede si approvano anche dall'iPhone; vale la stessa autenticazione della chat.
- **Permessi di macOS (TCC):** dipendono da come si avvia il core; con l'installer vero andrà rifatta la prova.
