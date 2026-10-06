/**
 * Common UI primitives barrel — the seucode design system. Usage rules live
 * in each file's header and in design-spec.md; every primitive renders in
 * the internal style guide (OMP_GUI_STYLEGUIDE=1).
 */

export { AsyncSection, type AsyncSectionProps } from "./AsyncSection";
export { Badge, type BadgeProps, type BadgeVariant } from "./Badge";
export { Banner, type BannerProps, type BannerVariant } from "./Banner";
export { BrandMark, type BrandMarkProps, type BrandMarkVariant } from "./BrandMark";
export { Button, type ButtonProps, type ButtonSize, type ButtonVariant } from "./Button";
export { ConfirmDialog, type ConfirmDialogProps } from "./ConfirmDialog";
export {
	anchorFromEvent,
	ContextMenu,
	type ContextMenuAnchor,
	type ContextMenuItem,
	type MenuAlign,
	MenuButton,
	type MenuButtonProps,
} from "./ContextMenu";
export { EmptyState, type EmptyStateProps } from "./EmptyState";
export { IconButton, type IconButtonProps, type IconButtonSize } from "./IconButton";
export {
	type FieldSize,
	Input,
	type InputProps,
	SearchField,
	type SearchFieldProps,
	TextArea,
	type TextAreaProps,
} from "./Input";
export { Kbd, type KbdProps } from "./Kbd";
export { LangSwitcher, type LangSwitcherProps } from "./LangSwitcher";
export { ListRow, type ListRowProps } from "./ListRow";
export { Modal, type ModalPlacement, type ModalProps, type ModalSize } from "./Modal";
export { PageLayout, type PageLayoutProps } from "./PageLayout";
export { PanelErrorBoundary } from "./PanelErrorBoundary";
export { Popover, type PopoverPlacement, type PopoverProps } from "./Popover";
export { ProgressBar, type ProgressBarProps } from "./ProgressBar";
export { Select, type SelectOption, type SelectProps } from "./Select";
export { Sheet, type SheetProps, type SheetSide, type SheetSize } from "./Sheet";
export { Spinner, type SpinnerProps, type SpinnerSize } from "./Spinner";
export { Switch, SwitchField, type SwitchFieldProps, type SwitchProps, type SwitchSize } from "./Switch";
export { type TabItem, Tabs, type TabsProps, type TabsVariant } from "./Tabs";
export { ToastStack } from "./Toast";
export { Tooltip, type TooltipProps, type TooltipSide } from "./Tooltip";
export { type TreeNode, TreeView, type TreeViewProps } from "./TreeView";
