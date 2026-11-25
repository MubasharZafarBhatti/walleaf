import { useAppData } from './useAppData';
import { useAppDialog } from '../components/dialogs/AppDialogProvider';
import { calculateAccountBalance, projectAccountOutflow } from '../services/finance/FinanceService';
import type { PersonEntry, Transaction } from '../types/models';
import { formatMoney } from '../utils/money';

export function useConfirmOutflow() {
  const { db, repo, currentRows } = useAppData();
  const { confirm } = useAppDialog();
  return async (accountId: string, outflowMinor: number): Promise<boolean> => {
    if (outflowMinor === 0) return true;
    if (!db) throw new Error('Database unavailable');
    // Re-reading every transaction before each save is slow on budget phones; the loaded rows
    // are used when nothing was written since they were read (else the database is read as before).
    const loaded = await currentRows?.(db).catch(() => null);
    const [accounts, transactions, entries] = loaded
      ? [loaded.accounts, loaded.transactions, loaded.entries]
      : await Promise.all([repo.listAccounts(db), repo.listTransactions(db), repo.listPersonEntries(db)]);
    const account = accounts.find((item) => item.id === accountId);
    if (!account) throw new Error('Choose an active account.');
    const projection = projectAccountOutflow(account, transactions, entries, outflowMinor);
    return !projection.needsConfirmation || confirm({
      title: `${account.name} will become negative`,
      message: `This payment will leave ${account.name} at ${formatMoney(projection.resultingBalanceMinor, account.currency)}.`,
    });
  };
}

export function useConfirmActivityChange() {
  const { accounts } = useAppData();
  const confirmOutflow = useConfirmOutflow();
  return async (oldTransactions: Transaction[], oldEntries: PersonEntry[], newTransactions: Transaction[], newEntries: PersonEntry[]) => {
    for (const account of accounts) {
      const before = calculateAccountBalance(account, oldTransactions, oldEntries);
      const after = calculateAccountBalance(account, newTransactions, newEntries);
      if (before > after && !await confirmOutflow(account.id, before - after)) return false;
    }
    return true;
  };
}
