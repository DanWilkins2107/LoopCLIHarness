// A hung loop's only other stop signal is a clean exit, so without this reaper
// it bills until someone notices. Long enough to sit out a usage-limit wait.
export const MAX_INSTANCE_AGE_MINUTES = 12 * 60;
