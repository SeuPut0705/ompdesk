/**
 * Common UI primitives barrel — the ompdesk design system. Usage rules live
 * in each file's header and in README.md (the catalog); every primitive renders in
 * the internal style guide (OMP_GUI_STYLEGUIDE=1).
 */

export { AsyncSection, type AsyncSectionProps } from "./AsyncSection";
export { AutoTitleButton } from "./AutoTitleButton";
export { Badge, type BadgeProps, type BadgeVariant } from "./Badge";
export { Banner, type BannerProps, type BannerVariant } from "./Banner";
export { BrandMark, type BrandMarkProps, type BrandMarkVariant } from "./BrandMark";
export { Button, type ButtonProps, type ButtonSize, type ButtonVariant } from "./Button";
export { Card, type CardPadding, type CardProps, type CardSurface } from "./Card";
export { Checkbox, type CheckboxProps, Radio, type RadioProps } from "./Checkbox";
export { type ChoiceCard, ChoiceCards, type ChoiceCardsProps } from "./ChoiceCards";
export { Collapse } from "./Collapse";
export { ConfirmDialog, type ConfirmDialogProps } from "./ConfirmDialog";
export {
	anchorFromEvent,
	ContextMenu,
	type ContextMenuAnchor,
	type ContextMenuItem,
	type MenuAlign,
	MenuButton,
	type MenuButtonProps,
	type MenuSelectModifiers,
} from "./ContextMenu";
export { CopyButton, type CopyButtonProps } from "./CopyButton";
export { CostAmount, hasCost } from "./CostAmount";
export { DisclosureButton, type DisclosureButtonProps } from "./DisclosureButton";
export { EmptyState, type EmptyStateProps } from "./EmptyState";
export { ErrorDetail } from "./ErrorDetail";
export { IconButton, type IconButtonProps, type IconButtonSize } from "./IconButton";
export { InlineNotice, type InlineNoticeTone } from "./InlineNotice";
export {
	type FieldSize,
	Input,
	type InputProps,
	SearchField,
	type SearchFieldProps,
	TextArea,
	type TextAreaProps,
} from "./Input";
export { JumpToLatest, type JumpToLatestProps } from "./JumpToLatest";
export { Kbd, type KbdProps } from "./Kbd";
export { LangSwitcher, type LangSwitcherProps } from "./LangSwitcher";
export { LinkButton, type LinkButtonProps } from "./LinkButton";
export { ListRow, type ListRowProps } from "./ListRow";
export { LIVE_PERIOD_MS, type LiveState, LiveSweep, LiveText, useWindowVisible } from "./LiveShimmer";
export {
	MasterDetail,
	MasterDetailBack,
	type MasterDetailProps,
	useMasterDetail,
} from "./MasterDetail";
export { Modal, type ModalAnchor, type ModalPlacement, type ModalProps, type ModalSize } from "./Modal";
export { OptionRow, type OptionRowProps } from "./OptionRow";
export { PageLayout, type PageLayoutProps } from "./PageLayout";
export { PanelErrorBoundary } from "./PanelErrorBoundary";
export { PathText, type PathTextProps } from "./PathText";
export { PinchZoomArea } from "./PinchZoomArea";
export { Popover, type PopoverPlacement, type PopoverProps } from "./Popover";
export {
	ProgressBar,
	type ProgressBarProps,
	type ProgressBarTone,
	type ProgressSegment,
	type SegmentedProgressBarProps,
} from "./ProgressBar";
export { QrCode } from "./QrCode";
export { RootErrorBoundary } from "./RootErrorBoundary";
export { SectionLabel, type SectionLabelProps } from "./SectionLabel";
export {
	SegmentedChoice,
	type SegmentedChoiceProps,
	type SegmentedOption,
} from "./SegmentedChoice";
export { Select, type SelectOption, type SelectProps } from "./Select";
export { SessionTitle, type SessionTitleProps } from "./SessionTitle";
export { INLINE_DESCRIPTION_MAX, SettingInfo, splitDescription } from "./SettingInfo";
export { Sheet, type SheetPlacement, type SheetProps, type SheetSize } from "./Sheet";
export { Skeleton, SkeletonRows } from "./Skeleton";
export { Spinner, type SpinnerProps, type SpinnerSize } from "./Spinner";
export { StatusDot, type StatusDotProps, type StatusTone } from "./StatusDot";
export { SwapText } from "./SwapText";
export {
	Switch,
	SwitchField,
	type SwitchFieldProps,
	type SwitchProps,
	type SwitchSize,
	SwitchTile,
	type SwitchTileProps,
} from "./Switch";
export { type TabItem, Tabs, type TabsProps, type TabsVariant } from "./Tabs";
export { TextEditor, type TextEditorLanguage, type TextEditorProps } from "./TextEditor";
export { TimeAgo } from "./TimeAgo";
export { ToastStack } from "./Toast";
export { Tooltip, type TooltipProps, type TooltipSide } from "./Tooltip";
export { type TreeNode, TreeView, type TreeViewProps } from "./TreeView";
export { MAX_USAGE_COLUMNS, NEAR_FRACTION, UsageGauges, usageDescription, usageTooltip } from "./UsageGauges";
export { useHeldOverlay } from "./use-held-overlay";
export { WorkingArc } from "./WorkingArc";
export { type GalleryImage, ZoomableImage, type ZoomableImageHandle, type ZoomableImageProps } from "./ZoomableImage";
