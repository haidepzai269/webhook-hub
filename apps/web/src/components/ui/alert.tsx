import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

const alertVariants = cva(
  "group/alert relative grid w-full grid-cols-[0_1fr] items-start gap-y-0.5 rounded-lg border px-3 py-2.5 text-sm has-[>svg]:grid-cols-[calc(var(--spacing)*4)_1fr] has-[>svg]:gap-x-2.5 [&>svg]:size-4 [&>svg]:translate-y-0.5 [&>svg]:text-current has-data-[slot=alert-action]:pr-24",
  {
    variants: {
      variant: {
        info: "border-sky-500/30 bg-sky-500/10 text-sky-800 dark:text-sky-200",
        warning: "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200",
        destructive: "border-destructive/30 bg-destructive/10 text-destructive",
        success: "border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200",
      },
    },
    defaultVariants: { variant: "info" },
  }
)

function Alert({
  className,
  variant = "info",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      data-variant={variant}
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  )
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn("col-start-2 min-h-4 font-medium tracking-tight", className)}
      {...props}
    />
  )
}

function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn("col-start-2 grid justify-items-start gap-1 text-sm opacity-90 [&_p]:leading-relaxed", className)}
      {...props}
    />
  )
}

/** Nút/hành động đặt góc phải của Alert. */
function AlertAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-action"
      className={cn("absolute top-2 right-2", className)}
      {...props}
    />
  )
}

export { Alert, AlertTitle, AlertDescription, AlertAction, alertVariants }
