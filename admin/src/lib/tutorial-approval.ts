/** An uncertain response must never cause an automatic second paid approval. */
export async function confirmTutorialApproval<T extends { status: string }>(
  submit: () => Promise<T>,
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await submit();
  } catch (error) {
    // The server may have accepted the request before the connection failed.
    // Reconcile by reading; APPROVED means accepted, not that rendering finished.
    try {
      const current = await read();
      if (current.status === 'APPROVED') return current;
    } catch {
      // Keep the original error when the read also fails or access is denied.
    }
    throw error;
  }
}
