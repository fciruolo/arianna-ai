import { ref } from 'vue';

/**
 * The person of the series to open in Impostazioni → Personaggi (D-224) when
 * the page is reached from an agent's Aspetto: set there, read once by the page.
 */
export const seriesFocus = ref<string | null>(null);
