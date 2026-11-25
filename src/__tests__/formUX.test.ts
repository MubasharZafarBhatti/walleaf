import { act, createElement, useEffect, useState, type ReactNode } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { BackHandler, Modal, Text } from 'react-native';
import { AppDialogProvider, useAppDialog } from '../components/dialogs/AppDialogProvider';
import { useSubmitGuard } from '../hooks/useSubmitGuard';
import { useDirtyForm } from '../hooks/useDirtyForm';
import { useConfirmOutflow } from '../hooks/useConfirmOutflow';
import { projectAccountOutflow } from '../services/finance/FinanceService';
import { PrimaryButton, SecondaryButton } from '../components/common';
import { buildSharedExpensePostingPlan } from '../services/sharedExpense/SharedExpenseService';
import type { Account, PersonEntry, Transaction } from '../types/models';

const mockNavigation = {
  addListener: jest.fn(), isFocused: jest.fn(() => true), canGoBack: jest.fn(() => true),
  dispatch: jest.fn(), goBack: jest.fn(),
};
const mockRepo = { listAccounts: jest.fn(), listTransactions: jest.fn(), listPersonEntries: jest.fn() };
jest.mock('@react-navigation/native', () => ({ useNavigation: () => mockNavigation }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('../hooks/useAppData', () => ({ useAppData: () => ({ db: {}, repo: mockRepo, settings: { currency: 'USD' } }) }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 20, bottom: 0, left: 0, right: 0 }) }));
// The native Modal host is not mounted by this Jest runtime; retain its visible children.
jest.mock('react-native/Libraries/Modal/Modal', () => {
  const React = jest.requireActual('react');
  return { __esModule: true, default: function MockModal(props: { visible: boolean; children: ReactNode }) {
    return React.createElement('Modal', props, props.visible ? props.children : null);
  } };
});

const account: Account = {
  id: 'cash', name: 'Cash', type: 'CASH', currency: 'PKR', opening_balance_minor: 10000,
  is_archived: 0, created_at: '', updated_at: '', sync_status: 'LOCAL',
};

let renderer: ReactTestRenderer;
let dialog: ReturnType<typeof useAppDialog>;
let form: ReturnType<typeof useSubmitGuard>;
let dirty: ReturnType<typeof useDirtyForm>;
let confirmOutflow: ReturnType<typeof useConfirmOutflow>;
let setInput: (value: string) => void;
let input: string;
let beforeRemove: (event: { preventDefault: () => void; data: { action: object } }) => void;
let hardwareBack: () => boolean | null | undefined;
const refresh = jest.fn();

function Harness() {
  const [value, setValue] = useState('');
  const currentDialog = useAppDialog();
  const currentForm = useSubmitGuard(refresh);
  const currentDirty = useDirtyForm(!!value.trim(), currentForm.isSaving);
  const currentOutflow = useConfirmOutflow();
  useEffect(() => {
    input = value;
    setInput = setValue;
    dialog = currentDialog;
    form = currentForm;
    dirty = currentDirty;
    confirmOutflow = currentOutflow;
  }, [value, currentDialog, currentForm, currentDirty, currentOutflow]);
  return createElement(Text, null, value);
}

async function press(label: string) {
  await act(async () => {
    const button = renderer.root.findAll((node) => node.props.accessibilityLabel === label && typeof node.props.onPress === 'function')[0];
    expect(button).toBeDefined();
    await button!.props.onPress();
  });
}

beforeEach(async () => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  refresh.mockResolvedValue(undefined);
  mockRepo.listAccounts.mockResolvedValue([account]);
  mockRepo.listTransactions.mockResolvedValue([]);
  mockRepo.listPersonEntries.mockResolvedValue([]);
  mockNavigation.addListener.mockImplementation((_event, listener) => { beforeRemove = listener; return () => {}; });
  jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_event, listener) => {
    hardwareBack = () => listener({ type: 'hardwareBackPress', timeStamp: 0 });
    return { remove: jest.fn() };
  });
  await act(async () => { renderer = create(createElement(AppDialogProvider, null, createElement(Harness))); });
});

afterEach(async () => {
  await act(async () => renderer.unmount());
  jest.restoreAllMocks();
  jest.useRealTimers();
});

test('synchronous lock blocks two taps before React renders and exposes saving state', async () => {
  let release!: () => void;
  const write = jest.fn(() => new Promise<void>((resolve) => { release = resolve; }));
  let first!: Promise<void>;
  await act(async () => { first = form.submit(write); void form.submit(write); });
  expect(write).toHaveBeenCalledTimes(1);
  expect(form.saving).toBe(true);
  await act(async () => { release(); await first; });
  expect(form.saving).toBe(false);
});

test('repository failure keeps input and permits a later retry', async () => {
  await act(async () => setInput('Dinner 500'));
  await act(async () => form.submit(async () => { throw new Error('disk full'); }));
  expect(input).toBe('Dinner 500');
  expect(renderer.root.findByType(Modal).props.visible).toBe(true);
  await press('OK');
  const retry = jest.fn(async () => {});
  await act(async () => form.submit(retry));
  expect(retry).toHaveBeenCalledTimes(1);
});

test('cancelled validation or confirmation does not clear input or write', async () => {
  await act(async () => setInput('500'));
  const write = jest.fn();
  let pending!: Promise<void>;
  await act(async () => {
    pending = form.submit(async () => {
      if (!await dialog.confirm({ title: 'Confirm', message: 'Continue?' })) return;
      write();
    });
  });
  expect(form.saving).toBe(true);
  await press('Edit');
  await act(async () => pending);
  expect(write).not.toHaveBeenCalled();
  expect(input).toBe('500');
  expect(form.saving).toBe(false);
});

test('completed save plus refresh failure retries only refresh, never the write', async () => {
  refresh.mockRejectedValue(new Error('read failed'));
  const write = jest.fn(async () => {});
  const save = () => form.submit(async () => {
    await write();
    await form.saved('Expense saved', () => setInput(''));
  });
  await act(async () => save());
  await act(async () => save());
  expect(write).toHaveBeenCalledTimes(1);
  expect(refresh).toHaveBeenCalledTimes(2);
  refresh.mockResolvedValue(undefined);
  await press('Retry refresh');
  expect(write).toHaveBeenCalledTimes(1);
  expect(refresh).toHaveBeenCalledTimes(3);
});

test('leaving after save permanently blocks stale screen submit callbacks', async () => {
  const write = jest.fn(async () => {});
  const save = () => form.submit(async () => {
    await write();
    await form.saved('Saved', () => {}, true);
  });
  await act(async () => save());
  await act(async () => save());
  expect(write).toHaveBeenCalledTimes(1);
});

test('post-commit screen failure is not presented as a retryable write failure', async () => {
  const write = jest.fn(async () => {});
  const save = () => form.submit(async () => {
    await write();
    await form.saved('Saved', () => { throw new Error('navigation failed'); });
  });
  await act(async () => save());
  await act(async () => save());
  expect(write).toHaveBeenCalledTimes(1);
  expect(renderer.root.findAllByType(Text).some((node) => node.props.children === 'Could not save')).toBe(false);
});

test('submit stays locked across crossing and negative-balance confirmations', async () => {
  const write = jest.fn();
  let pending!: Promise<void>;
  const save = () => form.submit(async () => {
    if (!await dialog.confirm({ title: 'Balance will switch sides', message: 'They will owe you.' })) return;
    if (!await confirmOutflow('cash', 20000)) return;
    write();
  });
  await act(async () => { pending = save(); void save(); });
  await press('Continue');
  expect(form.saving).toBe(true);
  await act(async () => { void save(); });
  await press('Continue');
  await act(async () => pending);
  expect(write).toHaveBeenCalledTimes(1);
});

test('back is blocked during a write even on an otherwise pristine form', async () => {
  let release!: () => void;
  let pending!: Promise<void>;
  await act(async () => { pending = form.submit(() => new Promise<void>((resolve) => { release = resolve; })); });
  const event = { preventDefault: jest.fn(), data: { action: { type: 'GO_BACK' } } };
  await act(async () => beforeRemove(event));
  expect(event.preventDefault).toHaveBeenCalledTimes(1);
  expect(renderer.root.findByType(Modal).props.visible).toBe(false);
  await act(async () => { release(); await pending; });
});

test('primary saving button exposes actual disabled and busy state with progress text', async () => {
  await act(async () => renderer.update(createElement(PrimaryButton, { title: 'Save', saving: true, onPress: jest.fn() })));
  const button = renderer.root.findAll((node) => node.props.accessibilityLabel === 'Saving...' && node.props.disabled === true)[0];
  expect(button).toBeDefined();
  expect(button.props.accessibilityState).toEqual({ disabled: true, busy: true });
  expect(renderer.root.findAllByType(Text).some((node) => node.props.children === 'Saving...')).toBe(true);
});

test('secondary button disables goal-entry actions while saving', async () => {
  await act(async () => renderer.update(createElement(SecondaryButton, { title: 'Withdraw Money', disabled: true, onPress: jest.fn() })));
  const button = renderer.root.findAll((node) => node.props.accessibilityLabel === 'Withdraw Money' && node.props.disabled === true)[0];
  expect(button).toBeDefined();
  expect(button.props.accessibilityState.disabled).toBe(true);
});

test('hardware cancellation resolves pending confirm and releases submit lock', async () => {
  let pending!: Promise<void>;
  const write = jest.fn();
  await act(async () => {
    pending = form.submit(async () => {
      if (await dialog.confirm({ title: 'Negative', message: 'Continue?' })) write();
    });
  });
  await act(async () => renderer.root.findByType(Modal).props.onRequestClose());
  await act(async () => pending);
  expect(write).not.toHaveBeenCalled();
  expect(form.saving).toBe(false);
});

test('replacing a dialog cancels its pending confirmation', async () => {
  let pending!: Promise<boolean>;
  await act(async () => { pending = dialog.confirm({ title: 'First', message: 'First' }); });
  await act(async () => dialog.showDialog({ title: 'Replacement' }));
  expect(await pending).toBe(false);
});

test('provider unmount resolves a pending confirmation as cancellation', async () => {
  let pending!: Promise<boolean>;
  await act(async () => { pending = dialog.confirm({ title: 'Confirm', message: 'Continue?' }); });
  await act(async () => renderer.unmount());
  expect(await pending).toBe(false);
});

test('rapid double action press invokes its callback once', async () => {
  const action = jest.fn();
  await act(async () => dialog.showDialog({ title: 'Confirm', actions: [{ text: 'Continue', onPress: action }] }));
  const button = renderer.root.findAll((node) => node.props.accessibilityLabel === 'Continue' && typeof node.props.onPress === 'function')[0];
  await act(async () => { void button.props.onPress(); void button.props.onPress(); });
  expect(action).toHaveBeenCalledTimes(1);
});

test('untouched or whitespace-only form leaves without a discard dialog', async () => {
  await act(async () => setInput('   '));
  const event = { preventDefault: jest.fn(), data: { action: { type: 'GO_BACK' } } };
  await act(async () => beforeRemove(event));
  expect(event.preventDefault).not.toHaveBeenCalled();
  expect(renderer.root.findByType(Modal).props.visible).toBe(false);
});

test('dirty navigation keeps editing or dispatches exactly the original action on discard', async () => {
  await act(async () => setInput('Dinner'));
  const event = { preventDefault: jest.fn(), data: { action: { type: 'GO_BACK' } } };
  await act(async () => beforeRemove(event));
  expect(event.preventDefault).toHaveBeenCalled();
  await press('Keep Editing');
  expect(mockNavigation.dispatch).not.toHaveBeenCalled();
  expect(input).toBe('Dinner');
  await act(async () => beforeRemove(event));
  await press('Discard');
  expect(mockNavigation.dispatch).toHaveBeenCalledWith(event.data.action);
});

test('dirty hardware back opens one confirmation; hardware dialog cancellation keeps input', async () => {
  await act(async () => setInput('Dinner'));
  await act(async () => { expect(hardwareBack()).toBe(true); expect(hardwareBack()).toBe(true); });
  await act(async () => renderer.root.findByType(Modal).props.onRequestClose());
  expect(mockNavigation.goBack).not.toHaveBeenCalled();
  expect(input).toBe('Dinner');
  await act(async () => { hardwareBack(); });
  await press('Discard');
  expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
});

test('inline discard protects closing a form and can reset its input', async () => {
  await act(async () => setInput('Trip'));
  await act(async () => { void dirty.discard(() => setInput('')); });
  await press('Keep Editing');
  expect(input).toBe('Trip');
  await act(async () => { void dirty.discard(() => setInput('')); });
  await press('Discard');
  expect(input).toBe('');
});

test('success banner is nonblocking and its timer restarts for subsequent feedback', async () => {
  await act(async () => dialog.showSuccess('Expense saved'));
  expect(renderer.root.findByType(Modal).props.visible).toBe(false);
  expect(renderer.root.findAllByType(Text).some((node) => node.props.children === 'Expense saved')).toBe(true);
  await act(async () => jest.advanceTimersByTime(3000));
  await act(async () => dialog.showSuccess('Income saved'));
  await act(async () => jest.advanceTimersByTime(1000));
  expect(renderer.root.findAllByType(Text).some((node) => node.props.children === 'Income saved')).toBe(true);
  await act(async () => jest.advanceTimersByTime(2500));
  expect(renderer.root.findAllByType(Text).some((node) => node.props.children === 'Income saved')).toBe(false);
});

test.each([
  [10000, 9000, 1000, false], [10000, 10000, 0, false],
  [10000, 12500, -2500, true], [-10000, 2500, -12500, true], [-10000, 0, -10000, false],
])('projects balance %i minus outflow %i in integer minor units', (balance, outflow, result, warning) => {
  expect(projectAccountOutflow({ ...account, opening_balance_minor: balance }, [], [], outflow))
    .toEqual({ currentBalanceMinor: balance, resultingBalanceMinor: result, needsConfirmation: warning });
});

test.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid outflow %s', (amount) => {
  expect(() => projectAccountOutflow(account, [], [], amount)).toThrow();
});

test('projection preserves other-person-paid expense recognition without fake cash movement', () => {
  const plan = buildSharedExpensePostingPlan({
    title: 'Dinner', totalAmountMinor: 20000, accountId: 'cash', categoryId: 'food', occurredOn: '2026-09-12',
    payerIsSelf: false, payerPersonId: 'ali', payerName: 'Ali',
    shares: [{ name: 'You', isSelf: true, shareMinor: 10000 }, { name: 'Ali', personId: 'ali', isSelf: false, shareMinor: 10000 }],
  });
  const projection = projectAccountOutflow(account, [plan.personalExpenseTransaction as Transaction], plan.personEntries as PersonEntry[], 5000);
  expect(projection.resultingBalanceMinor).toBe(5000);
  expect(projection.needsConfirmation).toBe(false);
});

test("outflow confirmation reads fresh balances and formats the account's own currency", async () => {
  mockRepo.listAccounts.mockResolvedValue([{ ...account, opening_balance_minor: -10000 }]);
  let pending!: Promise<boolean>;
  await act(async () => { pending = confirmOutflow('cash', 2500); });
  expect(mockRepo.listTransactions).toHaveBeenCalledTimes(1);
  expect(renderer.root.findAllByType(Text).some((node) => node.props.children === 'This payment will leave Cash at - Rs. 125.')).toBe(true);
  await press('Continue');
  expect(await pending).toBe(true);
});

test('zero real outflow (other-paid Split) requires neither account read nor confirmation', async () => {
  expect(await confirmOutflow('unused', 0)).toBe(true);
  expect(mockRepo.listAccounts).not.toHaveBeenCalled();
  expect(renderer.root.findByType(Modal).props.visible).toBe(false);
});

test('balance read failure prevents proceeding instead of assuming zero', async () => {
  mockRepo.listTransactions.mockRejectedValueOnce(new Error('read failed'));
  await expect(confirmOutflow('cash', 100)).rejects.toThrow('read failed');
});
