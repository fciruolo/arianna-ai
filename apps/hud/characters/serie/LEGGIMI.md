# Pacchetto «serie»: fan art per uso personale

I personaggi di questa cartella (J.D., Turk, Elliot, Carla, Dr. Cox, Dr. Kelso, l'Inserviente, Ted e Laverne di Scrubs; Michael, Dwight, Jim, Pam, Oscar, Andy, Kevin, Angela e Creed di The Office; Marge, Homer, Mr. Burns, Lisa, Smithers, Bart e Boe dei Simpson, D-237) sono fan art disegnata da Claude in pixel art su richiesta dell'utente, **solo per uso personale** (D-211). Non sono opere originali del progetto: i personaggi appartengono ai titolari dei diritti delle serie.

Prima di rendere pubblico, condividere o dare a qualcuno una copia del repository vanno tolti, **anche dalla storia di git** (i nove personaggi di D-227 sono entrati con i commit del ramo `task/personaggi-nuovi-serie`: la riscrittura della storia deve coprire anche quelli):

- questa cartella `apps/hud/characters/serie/`;
- le mappe in `apps/hud/characters/art/serie/`, le righe `SERIES` e `SERIES_DIR` di `apps/hud/characters/originals.ts` e il loro giro in `apps/hud/characters/build.ts`;
- i riferimenti `serie/…` in `characters` di `apps/hud/themes/corsia/theme.json` e `apps/hud/themes/ufficio/theme.json` (i temi tornano ai costumi del pacchetto `originali`);
- i test che dipendono dal pacchetto: in `apps/hud/test/themes.test.ts` il controllo dei personaggi dei temi (pacchetto `serie` e Arianna, Coder e GOD dalle serie in Corsia e Ufficio); in `apps/hud/test/characters.test.ts` `SERIES`, `SERIES_DIR`, `ALL` e i due test D-211; in `apps/core/test/characters.test.ts` la costante `SERIES` e il test del pacchetto della serie; in `apps/core/test/themes.test.ts` la costante `SERIES` e le attese su Carla, Cox e l’Inserviente del designer;
- la riga `series:` di `characterDirs` in `apps/core/src/main.ts` (senza, il core non serve il pacchetto);
- il gruppo «Serie (fan art)» della galleria in `apps/hud/src/components/AgentsSettings.vue` (`SERIES_PACK` e le due righe della galleria);
- i nomi dei personaggi su Wikiquote e le pagine delle serie (D-224, D-227): `WIKIQUOTE_SPEAKERS` e `WIKIQUOTE_PAGES` in `apps/core/src/wikiquote.ts`, con i loro test in `apps/core/test/wikiquote.test.ts`, e il test col modello vero `apps/core/test/series-guard.test.ts`;
- nomi e personalità dei personaggi (D-214): `packages/agents/src/series-personas.ts` (con gli `aliases` di D-227, «Bob Kelso»), la sua riga in `packages/agents/src/index.ts`, `characterPart` in `apps/core/src/prompt-tail.ts`, il test `apps/core/test/series-personas.test.ts` (e il controllo di `characterChoiceOf` in `apps/core/test/themes.test.ts`) e il nome dei temi «Scrubs» e «The Office» in `theme.json` (con il suo controllo in `apps/hud/test/themes.test.ts`). Possono restare, perché senza il pacchetto non fanno nulla: il nome del personaggio sopra quello dell'agente nella chat (`apps/hud/src/lib/character-names.ts`, `AgentName.vue`), la scelta del personaggio come nella chat (`characterChoiceOf`, `servesSync`), i nomi per frammento del secondo scanner (`fragmentNamesOf`, `seriesNamesOfSource`, che senza `series-personas.ts` va tolto con lui).

I luoghi delle serie nell'ufficio pixel (D-216) vanno tolti anche loro: le mappe `apps/hud/src/office/maps/corsia.json` e `ufficio.json` con la loro scelta in `apps/hud/src/components/OfficePage.vue`, `apps/hud/src/lib/office/skins.ts` e i rami `corsia`/`ufficio` di `apps/hud/src/lib/office/draw.ts`, il test `apps/hud/test/office-skins.test.ts` (con `apps/hud/test/support/office-raster.ts`, che può restare). Senza di loro l'ufficio è quello di base con ogni tema.

Chi è chi nel tema (D-217) va tolto con loro: `seriesRosterBlock`, `seriesNamesOf` e `SERIES_ROSTER_SOURCE` in `packages/agents/src/series-personas.ts`, `rosterPart`, `userNamesPart`, `wornSeries` e `wornSeriesNames` in `apps/core/src/prompt-tail.ts`, `configureWornNames` in `apps/core/src/gateway.ts` con la sua chiamata in `apps/core/src/main.ts`, e i loro test.

Il nome `serie` può restare riservato: `SERIES_PACK` in `packages/config/src/characters.ts` e i controlli di `apps/core/src/characters.ts` non contengono nulla delle serie, e tengono rifiutata una cartella `data/characters/serie`.

Il tema «I Simpson» (D-237, ramo `task/tema-simpson`) va tolto tutto, perché non ha costumi degli originali a cui tornare:

- la cartella `apps/hud/themes/springfield/` (e il suo id nelle liste dei temi dei test: `apps/hud/test/themes.test.ts`, `apps/core/test/themes.test.ts`, `apps/core/test/series-guard.test.ts`, il nome in `THEME_NAME` di `apps/hud/src/lib/changes.ts` con `apps/hud/test/changes.test.ts`);
- le mappe `apps/hud/characters/art/serie/simpsons.ts`, con le sette righe in `SERIES` di `apps/hud/characters/originals.ts`, i PNG `marge`, `homer`, `burns`, `lisa`, `smithers`, `bart`, `boe` e le loro righe in `pack.json` di questa cartella (e la lista in `apps/core/test/characters.test.ts`);
- i personaggi in `packages/agents/src/series-simpsons.ts`, con la riga `...SIMPSONS_PERSONAS` e il suo import in `packages/agents/src/series-personas.ts`, e il test del tema in `apps/core/test/series-personas.test.ts`;
- la pagina `I Simpson` in `WIKIQUOTE_PAGES` e le sette voci in `WIKIQUOTE_SPEAKERS` di `apps/core/src/wikiquote.ts`, con il test dei nomi del doppiaggio in `apps/core/test/wikiquote.test.ts`;
- la centrale nucleare dell'ufficio pixel: `apps/hud/src/lib/office/springfield.ts`, la mappa `apps/hud/src/office/maps/springfield.json` con la sua riga in `MAP_TEXTS` di `apps/hud/src/components/OfficePage.vue`, `springfield` in `OFFICE_SKINS` e `PALETTES` di `apps/hud/src/lib/office/skins.ts`, i rami `springfield` di `apps/hud/src/lib/office/draw.ts` e `apps/hud/src/lib/office/world3d.ts` (con `STRIPE_HEIGHT`), e i loro test in `apps/hud/test/office-skins.test.ts` e `apps/hud/test/office-3d.test.ts`.

I fogli si rigenerano dalle mappe con `node apps/hud/characters/build.ts`; un test fallisce se i PNG non corrispondono alle mappe.
