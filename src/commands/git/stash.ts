'use strict';
/* eslint-disable no-loop-func */
import { QuickInputButton, QuickInputButtons, QuickPickItem, Uri, window } from 'vscode';
import { Container } from '../../container';
import { GitStashCommit, GitUri, Repository } from '../../git/gitService';
import {
	BreakQuickCommand,
	QuickCommandBase,
	QuickPickStep,
	StepAsyncGenerator,
	StepSelection,
	StepState
} from '../quickCommand';
import {
	CommandQuickPickItem,
	CommitQuickPick,
	CommitQuickPickItem,
	Directive,
	DirectiveQuickPickItem,
	FlagsQuickPickItem,
	QuickPickItemOfT,
	RepositoryQuickPickItem
} from '../../quickpicks';
import { Iterables, Strings } from '../../system';
import { GlyphChars } from '../../constants';
import { Logger } from '../../logger';
import { Messages } from '../../messages';

interface ApplyState {
	subcommand: 'apply';
	repo: Repository;
	stash: { stashName: string; message: string; ref: string; repoPath: string };
}

interface DropState {
	subcommand: 'drop';
	repo: Repository;
	stash: { stashName: string; message: string; ref: string; repoPath: string };
}

interface ListState {
	subcommand: 'list';
	repo: Repository;
}

interface PopState {
	subcommand: 'pop';
	repo: Repository;
	stash: { stashName: string; message: string; ref: string; repoPath: string };
}

type PushFlags = '--include-untracked' | '--keep-index';

interface PushState {
	subcommand: 'push';
	repo: Repository;
	message?: string;
	uris?: Uri[];
	flags: PushFlags[];
}

type State = ApplyState | DropState | ListState | PopState | PushState;
type StashStepState<T> = StepState<T> & { repo: Repository };

const subcommandToSubtitleMap = new Map<State['subcommand'], string>([
	['apply', 'Apply'],
	['drop', 'Drop'],
	['list', 'List'],
	['pop', 'Pop'],
	['push', 'Push']
]);
function getSubtitle(subcommand: State['subcommand'] | undefined) {
	return subcommand === undefined ? '' : subcommandToSubtitleMap.get(subcommand);
}

export interface StashGitCommandArgs {
	readonly command: 'stash';
	state?: Partial<State>;

	confirm?: boolean;
}

export class StashGitCommand extends QuickCommandBase<State> {
	private readonly Buttons = class {
		static readonly RevealInView: QuickInputButton = {
			iconPath: {
				dark: Container.context.asAbsolutePath('images/dark/icon-eye.svg') as any,
				light: Container.context.asAbsolutePath('images/light/icon-eye.svg') as any
			},
			tooltip: 'Reveal Stash in Repositories View'
		};
	};

	private _subcommand: string | undefined;

	constructor(args?: StashGitCommandArgs) {
		super('stash', 'stash', 'Stash', {
			description: 'shelves (stashes) local changes to be reapplied later'
		});

		if (args == null || args.state === undefined) return;

		let counter = 0;
		if (args.state.subcommand !== undefined) {
			counter++;
		}

		if (args.state.repo !== undefined) {
			counter++;
		}

		switch (args.state.subcommand) {
			case 'apply':
			case 'drop':
			case 'pop':
				if (args.state.stash !== undefined) {
					counter++;
				}
				break;

			case 'push':
				if (args.state.message !== undefined) {
					counter++;
				}

				break;
		}

		this._initialState = {
			counter: counter,
			confirm: args.confirm,
			...args.state
		};
	}

	get canConfirm(): boolean {
		return this._subcommand !== undefined && this._subcommand !== 'list';
	}

	get canSkipConfirm(): boolean {
		return this._subcommand === 'drop' ? false : super.canSkipConfirm;
	}

	get skipConfirmKey() {
		return `${this.key}${this._subcommand === undefined ? '' : `-${this._subcommand}`}:${this.pickedVia}`;
	}

	protected async *steps(): StepAsyncGenerator {
		const state: StepState<State> = this._initialState === undefined ? { counter: 0 } : this._initialState;
		let repos;

		while (true) {
			try {
				if (state.subcommand === undefined || state.counter < 1) {
					this._subcommand = undefined;

					const step = this.createPickStep<QuickPickItemOfT<State['subcommand']>>({
						title: this.title,
						placeholder: `Choose a ${this.label} command`,
						items: [
							{
								label: 'apply',
								description: 'integrates changes from the specified stash into the current branch',
								picked: state.subcommand === 'apply',
								item: 'apply'
							},
							{
								label: 'drop',
								description: 'deletes the specified stash',
								picked: state.subcommand === 'drop',
								item: 'drop'
							},
							{
								label: 'list',
								description: 'lists the saved stashes',
								picked: state.subcommand === 'list',
								item: 'list'
							},
							{
								label: 'pop',
								description:
									'integrates changes from the specified stash into the current branch and deletes the stash',
								picked: state.subcommand === 'pop',
								item: 'pop'
							},
							{
								label: 'push',
								description:
									'saves your local changes to a new stash and discards them from the working tree and index',
								picked: state.subcommand === 'push',
								item: 'push'
							}
						],
						buttons: [QuickInputButtons.Back]
					});
					const selection: StepSelection<typeof step> = yield step;

					if (!this.canPickStepMoveNext(step, state, selection)) {
						break;
					}

					state.subcommand = selection[0].item;
				}

				this._subcommand = state.subcommand;

				if (repos === undefined) {
					repos = [...(await Container.git.getOrderedRepositories())];
				}

				if (state.repo === undefined || state.counter < 2) {
					if (repos.length === 1) {
						state.counter++;
						state.repo = repos[0];
					} else {
						const active = state.repo ? state.repo : await Container.git.getActiveRepository();

						const step = this.createPickStep<RepositoryQuickPickItem>({
							title: `${this.title} ${getSubtitle(state.subcommand)}`,
							placeholder: 'Choose a repository',
							items: await Promise.all(
								repos.map(r =>
									RepositoryQuickPickItem.create(r, r.id === (active && active.id), {
										branch: true,
										fetched: true,
										status: true
									})
								)
							)
						});
						const selection: StepSelection<typeof step> = yield step;

						if (!this.canPickStepMoveNext(step, state, selection)) {
							continue;
						}

						state.repo = selection[0].item;
					}
				}

				switch (state.subcommand) {
					case 'apply':
					case 'pop':
						yield* this.applyOrPop(state as StashStepState<ApplyState | PopState>);
						break;
					case 'drop':
						yield* this.drop(state as StashStepState<DropState>);
						break;
					case 'list':
						yield* this.list(state as StashStepState<ListState>);
						break;
					case 'push':
						yield* this.push(state as StashStepState<PushState>);
						break;
					default:
						return undefined;
				}

				if (repos.length === 1) {
					state.counter--;
				}
				continue;
			} catch (ex) {
				if (ex instanceof BreakQuickCommand) break;

				Logger.error(ex, `${this.title}.${state.subcommand}`);

				switch (state.subcommand) {
					case 'apply':
					case 'pop':
						if (
							ex.message.includes(
								'Your local changes to the following files would be overwritten by merge'
							)
						) {
							void window.showWarningMessage(
								'Unable to apply stash. Your working tree changes would be overwritten'
							);

							return undefined;
						} else if (ex.message.includes('Auto-merging') && ex.message.includes('CONFLICT')) {
							void window.showInformationMessage('Stash applied with conflicts');

							return undefined;
						}

						void Messages.showGenericErrorMessage(
							`Unable to apply stash \u2014 ${ex.message.trim().replace(/\n+?/g, '; ')}`
						);

						return undefined;

					case 'drop':
						void Messages.showGenericErrorMessage('Unable to delete stash');

						return undefined;

					case 'push':
						if (ex.message.includes('newer version of Git')) {
							void window.showErrorMessage(`Unable to stash changes. ${ex.message}`);

							return undefined;
						}

						void Messages.showGenericErrorMessage('Unable to stash changes');

						return undefined;
				}

				throw ex;
			}
		}

		return undefined;
	}

	private async *applyOrPop(state: StashStepState<ApplyState> | StashStepState<PopState>): StepAsyncGenerator {
		while (true) {
			if (state.stash === undefined || state.counter < 3) {
				const stash = await Container.git.getStashList(state.repo.path);

				const step = this.createPickStep<CommitQuickPickItem<GitStashCommit>>({
					title: `${this.title} ${getSubtitle(state.subcommand)}${Strings.pad(GlyphChars.Dot, 2, 2)}${
						state.repo.formattedName
					}`,
					placeholder:
						stash === undefined
							? `${state.repo.formattedName} has no stashes`
							: 'Choose a stash to apply to your working tree',
					matchOnDetail: true,
					items:
						stash === undefined
							? [
									DirectiveQuickPickItem.create(Directive.Back, true),
									DirectiveQuickPickItem.create(Directive.Cancel)
							  ]
							: [
									...Iterables.map(stash.commits.values(), c =>
										CommitQuickPickItem.create(
											c,
											c.stashName === (state.stash && state.stash.stashName),
											{
												compact: true
											}
										)
									)
							  ],
					additionalButtons: [this.Buttons.RevealInView],
					onDidClickButton: (quickpick, button) => {
						if (button === this.Buttons.RevealInView) {
							if (quickpick.activeItems.length !== 0) {
								void Container.repositoriesView.revealStash(quickpick.activeItems[0].item, {
									select: true,
									expand: true
								});

								return;
							}

							void Container.repositoriesView.revealStashes(state.repo.path, {
								select: true,
								expand: true
							});
						}
					}
				});
				const selection: StepSelection<typeof step> = yield step;

				if (!this.canPickStepMoveNext(step, state, selection)) {
					break;
				}

				state.stash = selection[0].item;
			}

			if (this.confirm(state.confirm)) {
				const message =
					state.stash.message.length > 80
						? `${state.stash.message.substring(0, 80)}${GlyphChars.Ellipsis}`
						: state.stash.message;

				const step = this.createConfirmStep<QuickPickItem & { command: 'apply' | 'pop' }>(
					`Confirm ${this.title} ${getSubtitle(state.subcommand)}${Strings.pad(GlyphChars.Dot, 2, 2)}${
						state.repo.formattedName
					}`,
					[
						{
							label: `${this.title} ${getSubtitle(state.subcommand)}`,
							description: `${state.stash.stashName}${Strings.pad(GlyphChars.Dash, 2, 2)}${message}`,
							detail:
								state.subcommand === 'pop'
									? `Will delete ${
											state.stash!.stashName
									  } and apply the changes to the working tree of ${state.repo.formattedName}`
									: `Will apply the changes from ${state.stash!.stashName} to the working tree of ${
											state.repo.formattedName
									  }`,
							command: state.subcommand!
						},
						// Alternate confirmation (if pop then apply, and vice versa)
						{
							label: `${this.title} ${state.subcommand === 'pop' ? 'Apply' : 'Pop'}`,
							description: `${state.stash!.stashName}${Strings.pad(GlyphChars.Dash, 2, 2)}${message}`,
							detail:
								state.subcommand === 'pop'
									? `Will apply the changes from ${state.stash!.stashName} to the working tree of ${
											state.repo.formattedName
									  }`
									: `Will delete ${
											state.stash!.stashName
									  } and apply the changes to the working tree of ${state.repo.formattedName}`,
							command: state.subcommand === 'pop' ? 'apply' : 'pop'
						}
					],
					undefined,
					{
						placeholder: `Confirm ${this.title} ${getSubtitle(state.subcommand)}`,
						additionalButtons: [this.Buttons.RevealInView],
						onDidClickButton: (quickpick, button) => {
							if (button === this.Buttons.RevealInView) {
								void Container.repositoriesView.revealStash(state.stash!, {
									select: true,
									expand: true
								});
							}
						}
					}
				);
				const selection: StepSelection<typeof step> = yield step;

				if (!this.canPickStepMoveNext(step, state, selection)) {
					break;
				}

				state.subcommand = selection[0].command;
			}

			void Container.git.stashApply(state.repo.path, state.stash!.stashName, state.subcommand === 'pop');

			throw new BreakQuickCommand();
		}

		return undefined;
	}

	private async *drop(state: StashStepState<DropState>): StepAsyncGenerator {
		while (true) {
			if (state.stash === undefined || state.counter < 3) {
				const stash = await Container.git.getStashList(state.repo.path);

				const step = this.createPickStep<CommitQuickPickItem<GitStashCommit>>({
					title: `${this.title} ${getSubtitle(state.subcommand)}${Strings.pad(GlyphChars.Dot, 2, 2)}${
						state.repo.formattedName
					}`,
					placeholder:
						stash === undefined ? `${state.repo.formattedName} has no stashes` : 'Choose a stash to delete',
					matchOnDetail: true,
					items:
						stash === undefined
							? [
									DirectiveQuickPickItem.create(Directive.Back, true),
									DirectiveQuickPickItem.create(Directive.Cancel)
							  ]
							: [
									...Iterables.map(stash.commits.values(), c =>
										CommitQuickPickItem.create(
											c,
											c.stashName === (state.stash && state.stash.stashName),
											{
												compact: true
											}
										)
									)
							  ],
					additionalButtons: [this.Buttons.RevealInView],
					onDidClickButton: (quickpick, button) => {
						if (button === this.Buttons.RevealInView) {
							if (quickpick.activeItems.length !== 0) {
								void Container.repositoriesView.revealStash(quickpick.activeItems[0].item, {
									select: true,
									expand: true
								});

								return;
							}

							void Container.repositoriesView.revealStashes(state.repo.path, {
								select: true,
								expand: true
							});
						}
					}
				});
				const selection: StepSelection<typeof step> = yield step;

				if (!this.canPickStepMoveNext(step, state, selection)) {
					break;
				}

				state.stash = selection[0].item;
			}

			const message =
				state.stash.message.length > 80
					? `${state.stash.message.substring(0, 80)}${GlyphChars.Ellipsis}`
					: state.stash.message;

			const step = this.createConfirmStep(
				`Confirm ${this.title} ${getSubtitle(state.subcommand)}${Strings.pad(GlyphChars.Dot, 2, 2)}${
					state.repo.formattedName
				}`,
				[
					{
						label: `${this.title} ${getSubtitle(state.subcommand)}`,
						description: `${state.stash.stashName}${Strings.pad(GlyphChars.Dash, 2, 2)}${message}`,
						detail: `Will delete ${state.stash.stashName}`
					}
				],
				undefined,
				{
					placeholder: `Confirm ${this.title} ${getSubtitle(state.subcommand)}`,
					additionalButtons: [this.Buttons.RevealInView],
					onDidClickButton: (quickpick, button) => {
						if (button === this.Buttons.RevealInView) {
							void Container.repositoriesView.revealStash(state.stash!, {
								select: true,
								expand: true
							});
						}
					}
				}
			);
			const selection: StepSelection<typeof step> = yield step;

			if (!this.canPickStepMoveNext(step, state, selection)) {
				break;
			}

			void Container.git.stashDelete(state.repo.path, state.stash.stashName);

			throw new BreakQuickCommand();
		}

		return undefined;
	}

	private async *list(state: StashStepState<ListState>): StepAsyncGenerator {
		let pickedStash: GitStashCommit | undefined;

		while (true) {
			const stash = await Container.git.getStashList(state.repo.path);

			const step = this.createPickStep<CommitQuickPickItem<GitStashCommit>>({
				title: `${this.title} ${getSubtitle(state.subcommand)}${Strings.pad(GlyphChars.Dot, 2, 2)}${
					state.repo.formattedName
				}`,
				placeholder: stash === undefined ? `${state.repo.formattedName} has no stashes` : 'Choose a stash',
				matchOnDetail: true,
				items:
					stash === undefined
						? [
								DirectiveQuickPickItem.create(Directive.Back, true),
								DirectiveQuickPickItem.create(Directive.Cancel)
						  ]
						: [
								...Iterables.map(stash.commits.values(), c =>
									CommitQuickPickItem.create(c, c.ref === (pickedStash && pickedStash.ref), {
										compact: true
									})
								)
						  ],
				additionalButtons: [this.Buttons.RevealInView],
				onDidClickButton: (quickpick, button) => {
					if (button === this.Buttons.RevealInView) {
						if (quickpick.activeItems.length !== 0) {
							void Container.repositoriesView.revealStash(quickpick.activeItems[0].item, {
								select: true,
								expand: true
							});

							return;
						}

						void Container.repositoriesView.revealStashes(state.repo.path, {
							select: true,
							expand: true
						});
					}
				},
				keys: ['right', 'alt+right', 'ctrl+right'],
				onDidPressKey: async (quickpick, key) => {
					if (quickpick.activeItems.length === 0) return;

					const stash = quickpick.activeItems[0].item;
					await Container.repositoriesView.revealStash(stash, {
						select: true,
						focus: false,
						expand: true
					});
				}
			});
			const selection: StepSelection<typeof step> = yield step;

			if (!this.canPickStepMoveNext(step, state, selection)) {
				break;
			}

			pickedStash = selection[0].item;

			if (pickedStash !== undefined) {
				const step = this.createPickStep<CommandQuickPickItem>({
					title: `${this.title} ${getSubtitle(state.subcommand)}${Strings.pad(GlyphChars.Dot, 2, 2)}${
						state.repo.formattedName
					}${Strings.pad(GlyphChars.Dot, 2, 2)}${pickedStash.shortSha}`,
					placeholder: `${
						pickedStash.number === undefined ? '' : `${pickedStash.number}: `
					}${pickedStash.getShortMessage()}`,
					items: await CommitQuickPick.getItems(pickedStash, pickedStash.toGitUri(), { showChanges: false }),
					additionalButtons: [this.Buttons.RevealInView],
					onDidClickButton: (quickpick, button) => {
						if (button !== this.Buttons.RevealInView) return;

						void Container.repositoriesView.revealStash(pickedStash!, {
							select: true,
							expand: true
						});
					}
				});
				const selection: StepSelection<typeof step> = yield step;

				if (!this.canPickStepMoveNext(step, state, selection)) {
					continue;
				}

				const command = selection[0];
				if (command instanceof CommandQuickPickItem) {
					command.execute();

					throw new BreakQuickCommand();
				}
			}
		}

		return undefined;
	}

	// eslint-disable-next-line @typescript-eslint/require-await
	private async *push(state: StashStepState<PushState>): StepAsyncGenerator {
		if (state.flags == null) {
			state.flags = [];
		}

		while (true) {
			if (state.message === undefined || state.counter < 3) {
				const step = this.createInputStep({
					title: `${this.title} ${getSubtitle(state.subcommand)}${Strings.pad(GlyphChars.Dot, 2, 2)}${
						state.repo.formattedName
					}`,
					placeholder: 'Please provide a stash message',
					value: state.message
				});

				const value: StepSelection<typeof step> = yield step;

				if (!(await this.canInputStepMoveNext(step, state, value))) {
					break;
				}

				state.message = value;
			}

			if (this.confirm(state.confirm)) {
				const step: QuickPickStep<FlagsQuickPickItem<PushFlags>> = this.createConfirmStep(
					`Confirm ${this.title} ${getSubtitle(state.subcommand)}${Strings.pad(GlyphChars.Dot, 2, 2)}${
						state.repo.formattedName
					}`,
					state.uris === undefined || state.uris.length === 0
						? [
								FlagsQuickPickItem.create<PushFlags>(state.flags, [], {
									label: `${this.title} ${getSubtitle(state.subcommand)}`,
									description: state.message,
									detail: 'Will stash uncommitted changes'
								}),
								FlagsQuickPickItem.create<PushFlags>(state.flags, ['--include-untracked'], {
									label: `${this.title} ${getSubtitle(state.subcommand)} & Include Untracked`,
									description: `--include-untracked ${state.message}`,
									detail: 'Will stash uncommitted changes, including untracked files'
								}),
								FlagsQuickPickItem.create<PushFlags>(state.flags, ['--keep-index'], {
									label: `${this.title} ${getSubtitle(state.subcommand)} & Keep Staged`,
									description: `--keep-index ${state.message}`,
									detail: 'Will stash uncommitted changes, but will keep staged files intact'
								})
						  ]
						: [
								FlagsQuickPickItem.create<PushFlags>(state.flags, [], {
									label: `${this.title} ${getSubtitle(state.subcommand)}`,
									description: state.message,
									detail: `Will stash changes in ${
										state.uris.length === 1
											? GitUri.getFormattedPath(state.uris[0], { relativeTo: state.repo.path })
											: `${state.uris.length} files`
									}`
								}),
								FlagsQuickPickItem.create<PushFlags>(state.flags, ['--keep-index'], {
									label: `${this.title} ${getSubtitle(state.subcommand)} & Keep Staged`,
									description: `--keep-index ${state.message}`,
									detail: `Will stash changes in ${
										state.uris.length === 1
											? GitUri.getFormattedPath(state.uris[0], { relativeTo: state.repo.path })
											: `${state.uris.length} files`
									}, but will keep staged files intact`
								})
						  ],
					undefined,
					{ placeholder: `Confirm ${this.title} ${getSubtitle(state.subcommand)}` }
				);
				const selection: StepSelection<typeof step> = yield step;

				if (!this.canPickStepMoveNext(step, state, selection)) {
					break;
				}

				state.flags = selection[0].item;
			}

			void Container.git.stashSave(state.repo.path, state.message, state.uris, {
				includeUntracked: state.flags.includes('--include-untracked'),
				keepIndex: state.flags.includes('--keep-index')
			});

			throw new BreakQuickCommand();
		}

		return undefined;
	}
}
