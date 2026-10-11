/** An empty spawn environment may acquire this exact macOS runtime entry. */
export const assertOwnedReceiverEnvironment = (
  environment,
  platform,
  temporaryRoot,
) => {
  if (
    Object.keys(environment).some(
      (name) =>
        platform !== "darwin" ||
        !["__CF_USER_TEXT_ENCODING", "TMPDIR"].includes(name),
    ) ||
    (Object.hasOwn(environment, "TMPDIR") &&
      environment.TMPDIR !== temporaryRoot)
  )
    throw new Error("Receiver environment contains an undeclared entry");
};
