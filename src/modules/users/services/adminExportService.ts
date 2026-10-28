import User from '../../../models/userModel';
import { buildCsvFile, CSV_EXPORT_ROW_LIMIT, CsvFile } from '../../../commons/utils/csv';
import { buildUserListFilter, USER_LIST_FIELDS, UserListFilters } from './adminUserService';

const yesNo = (value?: boolean) => (value ? 'oui' : 'non');

/** Export CSV de la liste admin des membres, mêmes filtres que la liste paginée. */
export async function buildUsersCsv(filters: UserListFilters): Promise<CsvFile> {
  const rows = await User.find(buildUserListFilter(filters))
    .select(USER_LIST_FIELDS)
    .sort({ createdAt: -1 })
    .limit(CSV_EXPORT_ROW_LIMIT)
    .lean();

  return buildCsvFile('utilisateurs', rows, [
    { header: 'Pseudo', value: (u) => u.username },
    { header: 'Email', value: (u) => u.email },
    { header: 'Rôle', value: (u) => u.role },
    { header: 'Statut', value: (u) => u.accountStatus },
    { header: 'Motif suspension', value: (u) => u.suspension?.reason },
    { header: 'Suspension jusqu\'au', value: (u) => u.suspension?.until },
    { header: 'Email vérifié', value: (u) => yesNo(u.isEmailVerified) },
    { header: 'Identité vérifiée', value: (u) => yesNo(u.isIdentityVerified) },
    { header: 'Inscrit le', value: (u) => u.createdAt },
    { header: 'Dernière connexion', value: (u) => u.lastLogin }
  ]);
}
