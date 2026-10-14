# Pacchetto «serie»: fan art per uso personale

I personaggi di questa cartella (J.D., Turk, Elliot, Carla e Dr. Cox di Scrubs; Michael, Dwight, Jim e Pam di The Office) sono fan art disegnata da Claude in pixel art su richiesta dell'utente, **solo per uso personale** (D-211). Non sono opere originali del progetto: i personaggi appartengono ai titolari dei diritti delle serie.

Prima di rendere pubblico, condividere o dare a qualcuno una copia del repository vanno tolti, **anche dalla storia di git**:

- questa cartella `apps/hud/characters/serie/`;
- le mappe in `apps/hud/characters/art/serie/`, le righe `SERIES` e `SERIES_DIR` di `apps/hud/characters/originals.ts` e il loro giro in `apps/hud/characters/build.ts`;
- i riferimenti `serie/…` in `characters` di `apps/hud/themes/corsia/theme.json` e `apps/hud/themes/ufficio/theme.json` (i temi tornano ai costumi del pacchetto `originali`);
- i test che dipendono dal pacchetto: in `apps/hud/test/themes.test.ts` il controllo dei personaggi dei temi (pacchetto `serie` e Arianna, Coder e GOD dalle serie in Corsia e Ufficio); in `apps/hud/test/characters.test.ts` `SERIES`, `SERIES_DIR`, `ALL` e i due test D-211; in `apps/core/test/characters.test.ts` la costante `SERIES` e il test del pacchetto della serie; in `apps/core/test/themes.test.ts` la costante `SERIES` e le attese su Carla, Cox e il costume del designer;
- la riga `series:` di `characterDirs` in `apps/core/src/main.ts` (senza, il core non serve il pacchetto);
- il gruppo «Serie (fan art)» della galleria in `apps/hud/src/components/AgentsSettings.vue` (`SERIES_PACK` e le due righe della galleria).

Il nome `serie` può restare riservato: `SERIES_PACK` in `packages/config/src/characters.ts` e i controlli di `apps/core/src/characters.ts` non contengono nulla delle serie, e tengono rifiutata una cartella `data/characters/serie`.

I fogli si rigenerano dalle mappe con `node apps/hud/characters/build.ts`; un test fallisce se i PNG non corrispondono alle mappe.
