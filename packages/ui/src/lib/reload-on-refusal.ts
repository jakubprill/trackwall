/** A refusal (most often: the file changed since it was shown) reloads the list, so the version on disk shows to read. */
export async function reloadOnRefusal<T>(request: Promise<T>, reload: () => void): Promise<T> {
  try {
    return await request;
  } catch (err) {
    reload();
    throw err;
  }
}
