# Roadmap e stime

Le ore sono **mie stime, non misurate**: lavoro effettivo di uno sviluppatore esperto che fa scrivere quasi tutto il codice a Claude Code, comprese revisione, test e correzioni; escluse attese di download, modelli e hardware. Si ricalibrano a fine Fase 0: se lo scarto supera il 30%, si rifanno le stime delle fasi successive.

| Fase | Obiettivo | Ore | Criterio di uscita (manuale) |
| --- | --- | --- | --- |
| 0 Fondamenta | Repo, controlli locali, registro eventi, primo test, harness eval, layout portabile | 13-21 | `pnpm check` passa e blocca un commit rotto; evento scritto e letto dal DB con catena di hash valida |
| 1A Nucleo e chat | Policy, gateway, confinamento, router, orchestratore, adattatori locale e Claude Code, chat web | 65-97 | Con dati finti: 0 fughe L2 negli eval e canarino mai uscito; un task di coding L1 completato via Claude Code, uno L2 solo in locale; ripresa dopo `kill` del core; log del gateway leggibile |
| 1B Completamenti | Vault, Telegram, Codex, installer, wizard | 25-39 | Approvazione data da Telegram senza contenuti L2 nel messaggio; installazione pulita in cartella vuota |
| 2 Memoria e cardwall | Archivio, estrazione, ricerca ibrida, Mem0, cardwall, export/import | 64-96 | Domande su documenti veri (dopo verifica) con fonti corrette; cardwall usato per una settimana; ripristino da `export` provato su cartella nuova |
| 3 HUD e ufficio pixel | HUD Arianna, ufficio pixel, approvazioni e impostazioni in UI | 43-69 | Vedi agenti al lavoro e approvi azioni dall'HUD |
| 4 Voce e chiamate | Voce locale, delega, telefonia, chiamate in uscita | 50-90 | Conversazione fluida in italiano; chiamata in uscita con approvazione; nessun L2 letto salvo abilitazione |
| 5 Studio e mentor | Fonti, curriculum, ripasso FSRS, brief giornaliero | 25-45 | Una settimana di brief e ripassi utili |
| **Totale** | | **285-457** | Con margine 25%: 356-571 |

I dati veri entrano solo dopo il criterio della Fase 1A, e solo con una password del database non predefinita (`SECURITY.md`). La Fase 2 può partire appena chiusa la 1A: i task di 1B si fanno in parallelo, quando servono.

Rispetto alla prima stesura il totale sale di 15-23 ore: è lavoro che la specifica chiedeva ma che nessun task copriva (confinamento degli esecutori cloud, ripresa dopo riavvio, test di accettazione dell'orchestratore, Telegram, vault). In cambio il primo sistema utilizzabile arriva prima: 98-148 ore con margine invece di 110-168.

## Calendario

| Ore a settimana | Fino alla Fase 1A (già utile) | Progetto completo |
| --- | --- | --- |
| 10 | 10-15 settimane | 36-57 settimane |
| 20 | 5-7 settimane | 18-29 settimane |
| 30 | 3-5 settimane | 12-19 settimane |

Fasi 0+1A con margine: 98-148 ore. Fasi 0+1 complete con margine: 129-196 ore. Le idee scelte dalla lista (`OPEN-QUESTIONS.md`) si aggiungono, salvo quelle che sostituiscono lavoro previsto. Dopo la Fase 1A usa il sistema per qualche settimana prima di proseguire.

## Cosa accorcia davvero i tempi

1. **Percorso critico corto (D-017):** installer, wizard, Codex e Telegram escono dal percorso verso il primo uso reale.
2. **Rischio grosso per primo:** il test di accettazione del modello locale (1.4) arriva dopo 7-10 ore di Fase 1, non alla fine.
3. **Corsie parallele:** privacy, esecutori e nucleo sono indipendenti fino al router; con worktree paralleli il tempo di calendario scende, il collo di bottiglia resta la tua revisione.
4. **Controlli veloci:** `pnpm check` non ha bisogno di modelli né di rete (D-018, D-019).
5. **Niente da costruire due volte:** coda propria minima invece di una prova con DBOS (D-004); niente prova di due giorni con Hermes (idea 8); fatture dall'XML prima dell'OCR (D-022).
6. **Ordine per valore dopo la 1A:** il prodotto diventa davvero tuo con la Fase 2 (documenti, scadenze, cardwall); le Fasi 3, 4 e 5 sono indipendenti fra loro e il loro ordine si decide a fine Fase 2 in base all'uso (D-023).

## Epic per fase (ore)

**Fase 2 (64-96), in ordine di valore:** fatture da XML FatturaPA e scadenziario in Postgres, poi OCR per la carta 14-20 · cardwall backend e UI 12-18 · archivio e ingestione 8-12 (in parte anticipati: cattura in `kb/inbox/` D-080, riordino col modello locale D-086; mancano archivio cifrato, link, PDF, vocali e video) · KB markdown con frontmatter 6-9 · ricerca ibrida Qdrant 10-15 · memoria agenti Mem0 6-9 · agenti Archivista/Segretario 4-7 · export/import cifrati 4-6.

**Fase 3 (43-69):** layout HUD e WebSocket 10-15 · flusso eventi → UI 5-8 (in parte anticipato: righe di attività salvate D-083, crediti e file modificati delle deleghe D-082) · pixel-agents con `HookProvider` proprio 12-18 · approvazioni in UI 8-14 · pagina Impostazioni 8-14 (anticipata: D-071; prove dei modelli in background D-081).

**Richieste nuove dell'utente (2026-10-05, ore da stimare).** Vicino a "archivio e ingestione" della Fase 2: pagina "Pensieri" con campo libero e microfono sopra la cattura di D-080 e D-086; vista "Conoscenza" a grafo (fatta, D-087), poi archi per vicinanza di significato. Nella Fase 3, dentro "layout HUD": barra sinistra come quella di Claude Code e barra destra "Agenti", entrambe collassabili; ricerca su tutto il sistema; menu dei comandi "/" in chat; azioni del messaggio al passaggio del mouse; finestra delle decisioni in attesa. Tutto questo è in corso nella chat web, prima della Fase 3.

**Anticipato nella notte del 2026-10-05, fuori dall'ordine delle fasi:** nel perimetro della Fase 1A, chiamate ripetute fermate dal core (D-076, accettata); da confermare: storia dell'orchestratore ancorata con riassunti (D-077, Fase 1A), prova dei modelli del catalogo con gli eval dell'orchestratore (D-081: idea 8 dei "Prossimi passi" di `docs/HANDOFF.md`, vicina all'idea 16 di `OPEN-QUESTIONS.md` senza coincidere: là si confrontano i modelli, qui li si prova in background); importatore a sola lettura del catalogo "Agenzia" (D-079, prima parte). Solo proposti: Arianna sviluppata da dentro Arianna (D-078), pulsante "Aggiorna" fra sviluppo e produzione (D-088).

**Altre eccezioni alla regola delle fasi, scelte dall'utente:** chiamate via internet dalla chat web e chiamate di Arianna (D-066, D-067: Fase 4, "servizio voce" e "policy chiamate in uscita", sul branch `p4-chiamate`); ufficio pixel giocabile, tappa 1 (D-106, 2026-10-05: Fase 3, "pixel-agents"). Solo proposte: routine con chiamata del mattino (D-110, vicino al "brief giornaliero" della Fase 5).

**Fase 4 (50-90):** servizio voce Pipecat 12-20 · valutazione STT/TTS italiani locali 8-15 · delega e latenza 8-14 · telefonia SIP 14-26 · policy chiamate in uscita 8-15.

**Fase 5 (25-45):** ingestione fonti 8-14 · agente Mentor e curriculum 8-14 · ripasso FSRS 5-9 · brief giornaliero 4-8.

## Tagli possibili (decisione tua)

Se serve stringere ancora, queste parti non reggono altre parti e si possono rinviare senza conseguenze sul resto:

| Parte | Ore | Cosa perdi |
| --- | --- | --- |
| Wizard `init` (1.18) | 6-9 | Configurazione guidata; resta `arianna.toml` a mano con validazione (fatto, D-048) |
| Ufficio pixel | 12-18 | La vista pixel-art; l'HUD mostra comunque gli agenti |
| Telefonia SIP e chiamate in uscita | 22-41 | Le telefonate; restano voce nel browser e Telegram |
