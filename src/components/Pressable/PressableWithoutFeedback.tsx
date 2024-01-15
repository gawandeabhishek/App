import React from 'react';
import GenericPressable from './GenericPressable';
import type {PressableRef} from './GenericPressable/types';
import type PressableProps from './GenericPressable/types';

function PressableWithoutFeedback(
    {pressStyle, hoverStyle, focusStyle, disabledStyle, screenReaderActiveStyle, shouldUseHapticsOnPress, shouldUseHapticsOnLongPress, ...rest}: PressableProps,
    ref: PressableRef,
) {
    return (
        <GenericPressable
            // eslint-disable-next-line react/jsx-props-no-spreading
            {...rest}
            ref={ref}
        />
    );
}

PressableWithoutFeedback.displayName = 'PressableWithoutFeedback';

export default React.forwardRef(PressableWithoutFeedback);
