import { makeAgyProvider } from './agy-provider.js';

/**
 * Pure, lightweight provider discovery for cold model catalog/auth lookups.
 * Loading this entrypoint never mutates the agent model configuration.
 */
export default makeAgyProvider();
