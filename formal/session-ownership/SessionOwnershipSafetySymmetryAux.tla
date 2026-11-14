------------------- MODULE SessionOwnershipSafetySymmetryAux -------------------
EXTENDS SessionOwnership, TLC

\* Preconditions for independent name permutations; not a state constraint.
ASSUME /\ Sessions \cap Tags = {}
       /\ Sessions \cap OwnerIds = {}
       /\ Tags \cap OwnerIds = {}
       /\ None \notin (Sessions \cup Tags \cup OwnerIds)

\* Safety Spec only. The CHOOSE-based HostedTraceSpec is not symmetric.
\* Disjoint domains make this the direct product; the sentinel is fixed.
SafetyNamePermutations ==
    { ps @@ pt @@ po @@ (None :> None) :
        ps \in Permutations(Sessions),
        pt \in Permutations(Tags),
        po \in Permutations(OwnerIds) }
=============================================================================
