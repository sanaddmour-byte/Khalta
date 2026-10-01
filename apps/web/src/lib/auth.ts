import { useQuery } from '@tanstack/react-query';
import { meQuery } from './api';

export const useMe = () => useQuery(meQuery);
