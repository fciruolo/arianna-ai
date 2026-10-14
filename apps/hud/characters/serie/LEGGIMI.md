# Pacchetto «serie»: fan art per uso personale

I personaggi di questa cartella (J.D., Turk, Elliot, Carla e Dr. Cox di Scrubs; Michael, Dwight, Jim e Pam di The Office) sono fan art disegnata da Claude in pixel art su richiesta dell'utente, **solo per uso personale** (D-211). Non sono opere originali del progetto: i personaggi appartengono ai titolari dei diritti delle serie.

Prima di rendere pubblico, condividere o dare a qualcuno una copia del repository vanno tolti, **anche dalla storia di git**:

- questa cartella `apps/hud/characters/serie/`;
- le mappe in `apps/hud/characters/art/serie/` e le righe `SERIES` di `apps/hud/characters/originals.ts`;
- i riferimenti `serie/…` in `characters` di `apps/hud/themes/corsia/theme.json` e `apps/hud/themes/ufficio/theme.json` (i temi tornano ai costumi del pacchetto `originali`).

I fogli si rigenerano dalle mappe con `node apps/hud/characters/build.ts`; un test fallisce se i PNG non corrispondono alle mappe.
