import {RootStackParamList} from '@libs/Navigation/types';

declare global {
    namespace ReactNavigation {
        // eslint-disable-next-line
        interface RootParamList extends RootStackParamList {}
    }
    // eslint-disable-next-line
    var _IS_FABRIC: boolean;
}
